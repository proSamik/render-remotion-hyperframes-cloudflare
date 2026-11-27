/**
 * Runs the same coordinator without Cloudflare: every "instance" is a local process (or a local Docker container)
 * running the same task server. Used by the examples' `npm run local` / `npm run docker` and by CI.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { cleanup, createJob, progressOf, step } from './coordinator.ts';
import type { Fleet, JobRequest, RenderProgress } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise<number>((done, failed) => { const probe = createServer(); probe.once('error', failed); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const run = (command: string, args: string[]) => new Promise<string>((done, failed) => execFile(command, args, (error, stdout, stderr) => (error ? failed(new Error(stderr || error.message)) : done(stdout.trim()))));

export type LocalFleetOptions = {
  /** Node mode: absolute path of the engine module. */
  engine?: string;
  /** Extra environment for the task server (REMOTION_SITES_DIR, REMOTION_PROJECT_DIR, ...). */
  env?: Record<string, string>;
  /** Docker mode: image to run instead of a Node process. The image brings its own engine. */
  dockerImage?: string;
  dockerArgs?: string[];
  workDir: string;
};

export function createLocalFleet(options: LocalFleetOptions): Fleet & { close(): Promise<void>; startError: Error | null } {
  const instances = new Map<string, Promise<{ port: number; child?: ChildProcess; container?: string }>>();
  const start = async (name: string) => {
    const port = await freePort();
    if (options.dockerImage) {
      const container = `rrh-${name}`.slice(0, 60);
      await run('docker', ['run', '-d', '--rm', '--name', container, '-p', `127.0.0.1:${port}:8080`, ...(options.dockerArgs ?? []), options.dockerImage]);
      return { port, container };
    }
    const child = spawn(process.execPath, [join(here, 'container-server.ts')], {
      env: { ...process.env, ...options.env, PORT: String(port), RENDER_ENGINE: options.engine ?? '', RENDER_WORK_DIR: join(options.workDir, name) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return { port, child };
  };
  const stop = async (name: string) => {
    const pending = instances.get(name);
    if (!pending) return;
    instances.delete(name);
    const instance = await pending.catch(() => null);
    if (instance?.container) await run('docker', ['rm', '-f', instance.container]).catch(() => undefined);
    instance?.child?.kill('SIGTERM');
    if (!options.dockerImage) await rm(join(options.workDir, name), { recursive: true, force: true }).catch(() => undefined);
  };
  const fleet = {
    startError: null as Error | null,
    async fetch(name: string, path: string, init?: RequestInit) {
      if (!instances.has(name)) instances.set(name, start(name).catch((error) => { fleet.startError = error instanceof Error ? error : new Error(String(error)); throw error; }));
      const { port } = await instances.get(name)!;
      return fetch(`http://127.0.0.1:${port}${path}`, init);
    },
    destroy: stop,
    async close() { await Promise.all([...instances.keys()].map(stop)); },
  };
  return fleet;
}

/** Plan, render, join and copy the result to `out`, all on this machine. */
export async function renderLocally(input: { request: JobRequest; fleet: LocalFleetOptions; out: string; onProgress?: (progress: RenderProgress) => void; pollMs?: number }): Promise<RenderProgress & { out: string }> {
  const fleet = createLocalFleet(input.fleet);
  const job = createJob(`local-${Date.now().toString(36)}`, input.request);
  const stopAll = () => { void fleet.close().finally(() => process.exit(130)); };
  process.once('SIGINT', stopAll);
  try {
    while (job.phase !== 'done' && job.phase !== 'failed') {
      await step(job, fleet, null);
      // Locally an instance that cannot start (Docker not running, a bad image name) will not start later either.
      if (fleet.startError) throw new Error(`could not start an instance: ${fleet.startError.message}`);
      input.onProgress?.(progressOf(job));
      if (!['done', 'failed'].includes(job.phase as string)) await new Promise((done) => setTimeout(done, input.pollMs ?? 500));
    }
    const progress = progressOf(job);
    if ((job.phase as string) === 'failed' || !job.output?.instance) throw new Error(`render failed:\n${job.errors.map((error) => `  ${error.message}`).join('\n')}`);
    const out = resolve(input.out);
    await mkdir(dirname(out), { recursive: true });
    const response = await fleet.fetch(job.output.instance, `/files/${job.id}/${job.output.name}`);
    if (!response.ok || !response.body) throw new Error(`could not read the output: ${response.status}`);
    const hash = createHash('sha256');
    const body = Readable.fromWeb(response.body as any);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(out));
    if (hash.digest('hex') !== job.output.sha256) throw new Error('the output arrived damaged (hash differs)');
    await cleanup(job, fleet);
    return { ...progress, out };
  } finally {
    process.off('SIGINT', stopAll);
    await fleet.close();
  }
}
