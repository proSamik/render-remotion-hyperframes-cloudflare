/**
 * The task server that runs inside every container instance (and, for local runs, as a plain Node process).
 *
 *   GET    /health                 -> { ok, startedAt, vcpus }
 *   POST   /plan   { render }      -> Plan (asks the engine; a few seconds)
 *   POST   /tasks  TaskRequest     -> 202; the task runs in its own process. Posting the same id twice is harmless.
 *   GET    /tasks?job=<id>         -> { tasks: TaskStatus[], cpuSeconds, uptimeSeconds }
 *   DELETE /tasks/<id>             -> kills the task
 *   GET    /files/<job>/<name>     -> bytes (Content-Length set)
 *   PUT    /files/<job>/<name>     -> stores the body, answers { name, bytes, sha256 }: the receipt the sender compares
 *   DELETE /jobs/<job>             -> removes the job's files
 *
 * It never trusts a path from a request: job ids and file names are matched against a strict pattern.
 * No authentication here: the port is only reachable through the Worker, which checks the secret.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { FileInfo, TaskRequest, TaskStatus } from './types.ts';

const PORT = Number(process.env.PORT ?? 8080);
const WORK = process.env.RENDER_WORK_DIR ?? '/tmp/render-work';
const runner = join(dirname(fileURLToPath(import.meta.url)), 'task-runner.ts');
const startedAt = Date.now();
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** Busy CPU seconds of the whole machine. On Cloudflare the VM runs nothing else, so this is what is billed as active CPU. */
function cpuBusySeconds(): number {
  try {
    const [user, nice, system, , , irq, softirq, steal] = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number) as number[];
    return (user! + nice! + system! + irq! + softirq! + steal!) / 100;
  } catch {
    return cpus().reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq, 0) / 1000;
  }
}
const cpuAtStart = cpuBusySeconds();

type Task = { request: TaskRequest; status: TaskStatus; child?: ChildProcess; dir: string; startedAt: number; cpuAtStart: number };
const tasks = new Map<string, Task>();

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function runProcess(request: object, dir: string, name: string, onChild?: (child: ChildProcess) => void): Promise<{ code: number | null; result: any; stderr: string }> {
  return new Promise((resolve) => {
    const requestFile = join(dir, `${name}.request.json`);
    const resultFile = join(dir, `${name}.result.json`);
    void writeFile(requestFile, JSON.stringify(request)).then(() => {
      // detached: the task gets its own process group, so the browser and ffmpeg it starts can be killed with it.
      const child = spawn(process.execPath, [runner, requestFile, resultFile, join(dir, `${name}.progress.json`)], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      let stderr = '';
      child.stderr!.on('data', (data) => { stderr = (stderr + data).slice(-3000); });
      onChild?.(child);
      child.once('close', (code) => {
        let result: any = null;
        try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* killed or crashed before writing */ }
        resolve({ code, result, stderr });
      });
    });
  });
}

const killTree = (child?: ChildProcess) => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } } };

// Files above this size are uploaded in parts. RENDER_MULTIPART_ABOVE_MIB exists so the multipart path can be tested with a small file.
const MULTIPART_ABOVE = Number(process.env.RENDER_MULTIPART_ABOVE_MIB ?? 90) * 1024 * 1024;
// R2 wants every part except the last to have the same size, at least 5 MiB.
const PART_BYTES = Math.max(5, Math.min(64, Number(process.env.RENDER_MULTIPART_ABOVE_MIB ?? 64))) * 1024 * 1024;
/** Uploads a result. Above 90 MiB it goes in parts (the R2 gateway of ../worker speaks this small protocol): a request body through a Worker is limited to 100 MiB. */
async function putTo(url: string, path: string, bytes: number) {
  const fail = async (response: Response) => { throw new Error(`upload failed: ${response.status} ${(await response.text()).slice(0, 300)}`); };
  const send = (target: string, start: number, end: number) => fetch(target, { method: 'PUT', body: Readable.toWeb(createReadStream(path, { start, end: end - 1 })) as any, headers: { 'content-length': String(end - start) }, duplex: 'half' } as RequestInit);
  if (bytes <= MULTIPART_ABOVE || !url.startsWith('http://r2.internal/')) {
    const response = await send(url, 0, bytes);
    if (!response.ok) await fail(response);
    return;
  }
  const created = await fetch(`${url}?uploads`, { method: 'POST' });
  if (!created.ok) await fail(created);
  const { uploadId } = (await created.json()) as { uploadId: string };
  const parts: unknown[] = [];
  for (let start = 0, partNumber = 1; start < bytes; start += PART_BYTES, partNumber += 1) {
    const response = await send(`${url}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, start, Math.min(bytes, start + PART_BYTES));
    if (!response.ok) await fail(response);
    parts.push(await response.json());
  }
  const completed = await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST', body: JSON.stringify(parts), headers: { 'content-type': 'application/json' } });
  if (!completed.ok) await fail(completed);
}

async function runTask(task: Task) {
  const { request, status, dir } = task;
  try {
    await mkdir(dir, { recursive: true });
    // Storage mode, stitch: fetch every chunk first.
    for (const [name, url] of Object.entries(request.download ?? {})) {
      if (!SAFE.test(name)) throw new Error(`bad file name ${name}`);
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`download ${name}: ${response.status}`);
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(join(dir, name)));
    }
    const run = await runProcess({ task: request }, dir, request.id, (child) => { task.child = child; });
    if (run.code !== 0 || !run.result?.files) throw new Error(run.result?.error ?? `task process ended with code ${run.code}: ${run.stderr.slice(-1500)}`);
    const files: FileInfo[] = [];
    for (const name of run.result.files as string[]) files.push({ name, bytes: (await stat(join(dir, name))).size, sha256: await sha256File(join(dir, name)) });
    status.files = files;
    status.framesRendered = (request.endFrame ?? 0) - (request.startFrame ?? 0);
    status.wallSeconds = (Date.now() - task.startedAt) / 1000;
    status.cpuSeconds = cpuBusySeconds() - task.cpuAtStart;
    if (request.upload) {
      for (const file of files) { const url = request.upload[file.name] ?? request.upload['*']; if (url) await putTo(url, join(dir, file.name), file.bytes); }
      status.uploaded = true;
    }
    status.state = 'done';
  } catch (error) {
    status.state = 'failed';
    status.error = error instanceof Error ? error.message : String(error);
  } finally { task.child = undefined; }
}

const send = (response: ServerResponse, code: number, body: unknown) => { const text = JSON.stringify(body); response.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text); };
async function readJson(request: IncomingMessage): Promise<any> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}
function progressOf(task: Task): TaskStatus {
  if (task.status.state === 'running') { try { task.status.framesRendered = JSON.parse(readFileSync(join(task.dir, `${task.request.id}.progress.json`), 'utf8')).framesRendered ?? 0; } catch { /* nothing yet */ } }
  return task.status;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://container');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method ?? 'GET';
    if (parts.some((part) => !SAFE.test(part))) return send(response, 400, { error: 'bad path' });
    if (method === 'GET' && parts[0] === 'health') return send(response, 200, { ok: true, startedAt, vcpus: cpus().length, tasks: tasks.size });
    if (method === 'POST' && parts[0] === 'plan') {
      const dir = join(WORK, '_plan');
      await mkdir(dir, { recursive: true });
      const run = await runProcess({ plan: (await readJson(request)).render ?? {} }, dir, `plan-${Date.now()}`);
      return run.result?.plan ? send(response, 200, run.result.plan) : send(response, 422, { error: run.result?.error ?? run.stderr });
    }
    if (parts[0] === 'tasks' && method === 'POST') {
      const body = (await readJson(request)) as TaskRequest;
      if (!SAFE.test(body.id ?? '') || !SAFE.test(body.jobId ?? '')) return send(response, 400, { error: 'bad id' });
      if (!tasks.has(body.id)) {
        const task: Task = { request: body, dir: join(WORK, body.jobId), startedAt: Date.now(), cpuAtStart: cpuBusySeconds(), status: { id: body.id, kind: body.kind, state: 'running', framesRendered: 0, files: [] } };
        tasks.set(body.id, task);
        void runTask(task);
      }
      return send(response, 202, { id: body.id });
    }
    if (parts[0] === 'tasks' && method === 'GET') {
      const job = url.searchParams.get('job');
      const list = [...tasks.values()].filter((task) => (parts[1] ? task.request.id === parts[1] : !job || task.request.jobId === job)).map(progressOf);
      return send(response, 200, { tasks: list, cpuSeconds: cpuBusySeconds() - cpuAtStart, uptimeSeconds: (Date.now() - startedAt) / 1000 });
    }
    if (parts[0] === 'tasks' && method === 'DELETE' && parts[1]) {
      const task = tasks.get(parts[1]);
      if (task) { killTree(task.child); tasks.delete(parts[1]); }
      return send(response, 200, { deleted: Boolean(task) });
    }
    if (parts[0] === 'files' && parts[1] && parts[2]) {
      const path = join(WORK, parts[1], parts[2]);
      if (method === 'GET') {
        if (!existsSync(path)) return send(response, 404, { error: 'no such file' });
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': (await stat(path)).size });
        return void (await pipeline(createReadStream(path), response).catch(() => undefined));
      }
      if (method === 'PUT') {
        await mkdir(join(WORK, parts[1]), { recursive: true });
        const hash = createHash('sha256');
        let bytes = 0;
        request.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
        await pipeline(request, createWriteStream(path));
        return send(response, 200, { name: parts[2], bytes, sha256: hash.digest('hex') });
      }
    }
    if (parts[0] === 'jobs' && parts[1] && method === 'DELETE') {
      for (const [id, task] of tasks) if (task.request.jobId === parts[1]) { killTree(task.child); tasks.delete(id); }
      await rm(join(WORK, parts[1]), { recursive: true, force: true });
      return send(response, 200, { deleted: parts[1] });
    }
    return send(response, 404, { error: 'not found' });
  } catch (error) {
    if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    else response.destroy();
  }
});

// Cloudflare sends SIGTERM before it stops an instance (a deploy, a host restart). Stop the children and leave at once:
// the coordinator sees the tasks disappear and renders the chunks again somewhere else.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { for (const task of tasks.values()) killTree(task.child); server.close(); process.exit(0); });

server.listen(PORT, () => console.log(`render task server on :${PORT}, engine ${process.env.RENDER_ENGINE ?? '(none)'}`));
