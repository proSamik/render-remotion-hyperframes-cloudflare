/**
 * The task server as a process: the optional self-test at start, and the atomic file upload.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '../src/container-server.ts');
const freePort = () => new Promise<number>((done) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
async function start(env: Record<string, string>) {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'rrh-server-'));
  const child = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), RENDER_WORK_DIR: dir, ...env }, stdio: 'ignore' });
  const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  for (let tries = 0; tries < 100; tries += 1) { if (await get('/health').then(() => true, () => false)) break; await new Promise((done) => setTimeout(done, 100)); }
  return { get, dir, stop: async () => { child.kill('SIGTERM'); await rm(dir, { recursive: true, force: true }); } };
}
const until = async (check: () => Promise<boolean>) => { for (let tries = 0; tries < 100; tries += 1) { if (await check()) return true; await new Promise((done) => setTimeout(done, 100)); } return false; };

test('with a self-test the server answers 503 until it passed, and stays 503 when it failed', async () => {
  const passing = await start({ RENDER_SELFTEST: `"${process.execPath}" -e "setTimeout(() => process.exit(0), 700)"` });
  const failing = await start({ RENDER_SELFTEST: `"${process.execPath}" -e "console.error('no WebGL2 context'); process.exit(1)"` });
  try {
    assert.equal((await passing.get('/health')).status, 503);
    assert.equal((await passing.get('/tasks?job=x')).status, 503, 'an instance that is still testing itself must not look ready to the coordinator');
    assert.ok(await until(async () => (await passing.get('/health')).status === 200));
    assert.equal((await passing.get('/tasks?job=x')).status, 200);
    assert.ok(await until(async () => ((await (await failing.get('/health')).json()) as { selftest?: string }).selftest === 'failed'));
    const answer = await failing.get('/tasks?job=x');
    assert.equal(answer.status, 503);
    assert.match(((await answer.json()) as { output: string }).output, /no WebGL2 context/);
  } finally { await passing.stop(); await failing.stop(); }
});

test('a file sent to the server gets its name only when it is complete, and the receipt carries its hash', async () => {
  const plain = await start({});
  try {
    const body = Buffer.alloc(300_000, 7);
    const receipt = (await (await plain.get('/files/job1/chunk-0000-r1.ts', { method: 'PUT', body })).json()) as { bytes: number; sha256: string };
    assert.deepEqual(receipt, { name: 'chunk-0000-r1.ts', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    assert.deepEqual(await readdir(join(plain.dir, 'job1')), ['chunk-0000-r1.ts']);
    assert.equal((await plain.get('/files/job1/..%2Fx')).status, 400);
    // names inside a task are checked like names in a path
    const task = { id: 'job1-chunk-0000-r1', jobId: 'job1', kind: 'chunk', render: {}, plan: {}, outputBase: '../../escape' };
    assert.equal((await plain.get('/tasks', { method: 'POST', body: JSON.stringify(task) })).status, 400);
    assert.equal((await plain.get('/tasks', { method: 'POST', body: JSON.stringify({ ...task, outputBase: 'ok', kind: 'stitch', chunks: [{ index: 0, files: [{ name: '/etc/passwd', bytes: 1, sha256: 'x' }] }] }) })).status, 400);
  } finally { await plain.stop(); }
});
