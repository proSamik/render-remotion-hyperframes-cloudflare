/**
 * The coordinator against a simulated fleet: no browser, no network. Each test is one of the failures seen on
 * real Cloudflare Containers. Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, progressOf, step } from '../src/coordinator.ts';
import type { Fleet, JobState, TaskRequest, TaskStatus } from '../src/types.ts';

type Behaviour = {
  /** instance never answers before this simulated time (a slow cold start) */
  slowUntil?: Record<string, number>;
  /** tasks whose id matches never finish */
  hang?: RegExp;
  /** the instance forgets its tasks once, at this time (a restart) */
  restart?: { instance: string; at: number };
  /** the first N transfers arrive with wrong bytes */
  corruptTransfers?: number;
  /** tasks whose id matches fail */
  failTask?: RegExp;
};

function simulate(behaviour: Behaviour = {}, plan = { fps: 30, durationInFrames: 360, width: 1920, height: 1080, chunkable: true }) {
  let now = 0;
  const instances = new Map<string, { tasks: Map<string, TaskStatus & { doneAt: number }>; files: Map<string, string>; destroyed: boolean }>();
  const destroyed: string[] = [];
  let restarted = false;
  let corrupt = behaviour.corruptTransfers ?? 0;
  const get = (name: string) => { if (!instances.has(name)) instances.set(name, { tasks: new Map(), files: new Map(), destroyed: false }); return instances.get(name)!; };
  const fleet: Fleet = {
    async fetch(name, path, init = {}) {
      if (now < (behaviour.slowUntil?.[name] ?? 0)) throw new Error('not ready');
      const instance = get(name);
      if (behaviour.restart && !restarted && name === behaviour.restart.instance && now >= behaviour.restart.at) { restarted = true; instance.tasks.clear(); instance.files.clear(); }
      const method = init.method ?? 'GET';
      if (path === '/plan') return Response.json(plan);
      if (path === '/tasks' && method === 'POST') {
        const task = JSON.parse(String(init.body)) as TaskRequest;
        const hangs = behaviour.hang?.test(task.id);
        const files = task.kind === 'stitch' ? ['out.mp4'] : task.kind === 'chunk' ? [`chunk-${String(task.chunkIndex).padStart(4, '0')}.ts`, `chunk-${String(task.chunkIndex).padStart(4, '0')}.aac`] : ['out.mp4'];
        if (task.kind === 'stitch') for (let index = 0; index < task.chunkCount!; index += 1) assert.ok(instance.files.has(`chunk-${String(index).padStart(4, '0')}.ts`), `stitcher is missing chunk ${index}`);
        instance.tasks.set(task.id, { id: task.id, kind: task.kind, state: 'running', framesRendered: 0, files: files.map((file) => ({ name: file, bytes: 10, sha256: `hash-${file}` })), doneAt: hangs ? Infinity : now + 4000, ...(behaviour.failTask?.test(task.id) ? { error: 'boom' } : {}) });
        return Response.json({ id: task.id }, { status: 202 });
      }
      if (path.startsWith('/tasks?')) {
        const tasks = [...instance.tasks.values()].map((task) => {
          if (task.state === 'running' && now >= task.doneAt) { task.state = task.error ? 'failed' : 'done'; task.wallSeconds = 4; if (!task.error) for (const file of task.files) instance.files.set(file.name, file.sha256); }
          return task;
        });
        return Response.json({ tasks, cpuSeconds: now / 1000, uptimeSeconds: now / 1000 });
      }
      if (path.startsWith('/tasks/') && method === 'DELETE') { instance.tasks.delete(path.split('/')[2]!); return Response.json({}); }
      if (path.startsWith('/files/')) {
        const file = path.split('/')[3]!;
        if (method === 'GET') return instance.files.has(file) ? new Response('0123456789') : new Response('missing', { status: 404 });
        await new Response(init.body).arrayBuffer();
        const damaged = corrupt > 0;
        if (damaged) corrupt -= 1;
        instance.files.set(file, `hash-${file}`);
        return Response.json({ name: file, bytes: 10, sha256: damaged ? 'wrong' : `hash-${file}` });
      }
      return new Response('not found', { status: 404 });
    },
    async destroy(name) { destroyed.push(name); instances.delete(name); },
  };
  const run = async (job: JobState, limitMs = 30 * 60_000) => {
    while (job.phase !== 'done' && job.phase !== 'failed' && now < limitMs) { await step(job, fleet, null, now); now += 1500; }
    return job;
  };
  return { fleet, run, destroyed, time: () => now };
}

const request = (fleet = {}) => ({ render: { composition: 'Test' }, fleet: { instances: 2, processesPerInstance: 2, ...fleet } });

test('plans equal chunks, renders on two instances, moves files to one, stitches', async () => {
  const sim = simulate();
  const job = await sim.run(createJob('job1', request()));
  assert.equal(job.phase, 'done');
  assert.equal(job.chunks.length, 4);
  assert.deepEqual(job.chunks.map((chunk) => chunk.endFrame - chunk.startFrame), [90, 90, 90, 90]);
  assert.equal(job.output?.name, 'out.mp4');
  assert.equal(progressOf(job).overallProgress, 1);
  // every instance except the one holding the output was stopped
  assert.equal(job.instances.filter((instance) => !instance.gone).length, 1);
});

test('every chunk has the same length except the last', async () => {
  const sim = simulate({}, { fps: 30, durationInFrames: 400, width: 1920, height: 1080, chunkable: true });
  const job = await sim.run(createJob('job2', request({ framesPerChunk: 150 })));
  assert.deepEqual(job.chunks.map((chunk) => chunk.endFrame - chunk.startFrame), [150, 150, 100]);
});

test('a slow cold start does not hold the job up: the other instance takes the chunks', async () => {
  const sim = simulate({ slowUntil: { 'job3-1': 10 * 60_000 } });
  const job = await sim.run(createJob('job3', request()));
  assert.equal(job.phase, 'done');
  assert.ok(sim.time() < 60_000, `finished after ${sim.time()} ms without waiting for the slow instance`);
  assert.ok(job.chunks.every((chunk) => chunk.instance === 'job3-0'));
});

test('a hanging chunk passes its deadline, its instance is replaced, the chunk is rendered again', async () => {
  const sim = simulate({ hang: /chunk-0001-a0/ });
  const job = await sim.run(createJob('job4', request({ chunkDeadlineSeconds: 20, duplicateStragglers: false })));
  assert.equal(job.phase, 'done');
  assert.equal(job.chunks[1]!.attempts, 1);
  assert.ok(job.errors.some((error) => /deadline/.test(error.message)));
  assert.ok(sim.destroyed.length >= 1);
});

test('a straggler gets a second copy on a free slot and the first result wins', async () => {
  const sim = simulate({ hang: /chunk-0003-a0-1$/ });
  const job = await sim.run(createJob('job5', request({ chunkDeadlineSeconds: 600 })));
  assert.equal(job.phase, 'done');
  assert.ok(job.errors.some((error) => /straggler/.test(error.message)));
  assert.ok(sim.time() < 120_000);
});

test('an instance that restarts loses its tasks: the chunks are queued again', async () => {
  const sim = simulate({ restart: { instance: 'job6-0', at: 3000 } });
  const job = await sim.run(createJob('job6', request()));
  assert.equal(job.phase, 'done');
  assert.ok(job.errors.some((error) => /restarted/.test(error.message)));
});

test('a transfer that arrives damaged is repeated', async () => {
  const sim = simulate({ corruptTransfers: 1 });
  const job = await sim.run(createJob('job7', request()));
  assert.equal(job.phase, 'done');
  assert.ok(job.errors.some((error) => /damaged/.test(error.message)));
});

test('a chunk that keeps failing fails the job with the reason', async () => {
  const sim = simulate({ failTask: /chunk-0002/ });
  const job = await sim.run(createJob('job8', request({ maxRetries: 1 })));
  assert.equal(job.phase, 'failed');
  assert.ok(progressOf(job).fatalErrorEncountered);
  assert.ok(job.errors.some((error) => /boom/.test(error.message)));
});

test('an engine that cannot chunk renders in one piece on one instance', async () => {
  const sim = simulate({}, { fps: 30, durationInFrames: 240, width: 1920, height: 1080, chunkable: false });
  const job = await sim.run(createJob('job9', request({ instances: 3 })));
  assert.equal(job.phase, 'done');
  assert.equal(job.chunks.length, 1);
  assert.equal(job.instances.length, 1);
});

test('a chunk that hangs everywhere, also as a duplicate, still ends: instances are replaced until it renders', async () => {
  const sim = simulate({ hang: /chunk-0003-a[01]/ });
  const job = await sim.run(createJob('job10', request({ chunkDeadlineSeconds: 30, maxRetries: 3 })));
  assert.equal(job.phase, 'done');
  assert.ok(job.errors.filter((error) => /deadline/.test(error.message)).length >= 1);
});
