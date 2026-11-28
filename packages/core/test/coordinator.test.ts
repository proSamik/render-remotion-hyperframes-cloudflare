/**
 * The coordinator against a simulated fleet: no browser, no network. Each test is one of the failures seen on
 * real Cloudflare Containers. Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, progressOf, step } from '../src/coordinator.ts';
import { EVENT_LEVELS, toTrackerEvent } from '../src/events.ts';
import type { Fleet, JobState, Plan, Storage, TaskRequest, TaskStatus } from '../src/types.ts';

type Behaviour = {
  /** instance never answers before this simulated time (a slow cold start) */
  slowUntil?: Record<string, number>;
  /** every instance answers 503 "no Container instance available" before this time */
  unavailableUntil?: number;
  /** tasks whose id matches never finish and never report a frame */
  hang?: RegExp;
  /** tasks whose id matches render half their frames and then stop */
  stall?: RegExp;
  /** tasks whose id matches take this many times longer */
  slow?: { match: RegExp; factor: number };
  /** the instance forgets its tasks once, at this time (a restart) */
  restart?: { instance: string; at: number };
  /** the first N transfers arrive with wrong bytes */
  corruptTransfers?: number;
  /** tasks whose id matches fail */
  failTask?: RegExp;
  /** status codes of the first answers to POST /plan */
  planAnswers?: number[];
};

const TASK_MS = 4000;

function simulate(behaviour: Behaviour = {}, plan: Plan = { fps: 30, durationInFrames: 360, width: 1920, height: 1080, chunkable: true }) {
  let now = 0;
  type SimTask = TaskStatus & { startedAt: number; doneAt: number; frames: number; request: TaskRequest };
  const instances = new Map<string, { tasks: Map<string, SimTask>; files: Map<string, string>; bootAt: number }>();
  const destroyed: string[] = [];
  const started: TaskRequest[] = [];
  const stored = new Set<string>();
  const planAnswers = [...(behaviour.planAnswers ?? [])];
  let restarted = false;
  let corrupt = behaviour.corruptTransfers ?? 0;
  const get = (name: string) => { if (!instances.has(name)) instances.set(name, { tasks: new Map(), files: new Map(), bootAt: now }); return instances.get(name)!; };
  const fleet: Fleet = {
    async fetch(name, path, init = {}) {
      if (now < (behaviour.slowUntil?.[name] ?? 0)) throw new Error('not ready');
      if (now < (behaviour.unavailableUntil ?? 0)) return new Response('There is no Container instance available at this time.', { status: 503 });
      const instance = get(name);
      if (behaviour.restart && !restarted && name === behaviour.restart.instance && now >= behaviour.restart.at) { restarted = true; instance.tasks.clear(); instance.files.clear(); instance.bootAt = now; }
      const method = init.method ?? 'GET';
      if (path === '/plan') { const status = planAnswers.shift(); return status ? new Response(status === 500 ? 'Error proxying request to container' : 'no such composition', { status }) : Response.json(plan); }
      if (path === '/tasks' && method === 'POST') {
        const task = JSON.parse(String(init.body)) as TaskRequest;
        started.push(task);
        const files = task.kind === 'chunk' ? (task.plan.chunkFiles ?? ['.ts', '.aac']).map((suffix) => `${task.outputBase}${suffix}`) : ['out.mp4'];
        if (task.kind === 'stitch') {
          for (const chunk of task.chunks!) for (const file of chunk.files) {
            if (task.download) assert.ok(stored.has(task.download[file.name]!.replace('get:', '')), `the stitcher was sent to an object nobody wrote: ${file.name}`);
            else assert.ok(instance.files.has(file.name), `stitcher is missing ${file.name}`);
          }
        }
        const factor = behaviour.slow?.match.test(task.id) ? behaviour.slow.factor : 1;
        const never = behaviour.hang?.test(task.id) || behaviour.stall?.test(task.id);
        instance.tasks.set(task.id, { id: task.id, kind: task.kind, state: 'running', framesRendered: 0, files: files.map((file) => ({ name: file, bytes: 10, sha256: `hash-${file}` })), request: task, startedAt: now, doneAt: never ? Infinity : now + TASK_MS * factor, frames: (task.endFrame ?? 1) - (task.startFrame ?? 0), ...(behaviour.failTask?.test(task.id) ? { error: 'boom' } : {}) });
        return Response.json({ id: task.id }, { status: 202 });
      }
      if (path.startsWith('/tasks?')) {
        const tasks = [...instance.tasks.values()].map((task) => {
          if (task.state === 'running' && now >= task.doneAt) {
            task.state = task.error ? 'failed' : 'done'; task.wallSeconds = (task.doneAt - task.startedAt) / 1000; task.cpuSeconds = 2 * task.wallSeconds; task.framesRendered = task.frames;
            if (!task.error) for (const file of task.files) { instance.files.set(file.name, file.sha256); for (const url of Object.values(task.request.upload ?? {})) stored.add(url.replace('put:', '')); }
            if (task.request.upload) task.uploaded = true;
          } else if (task.state === 'running' && !behaviour.hang?.test(task.id)) {
            const share = behaviour.stall?.test(task.id) ? Math.min(0.5, (now - task.startedAt) / TASK_MS) : (now - task.startedAt) / (task.doneAt - task.startedAt);
            task.framesRendered = Math.floor(task.frames * share);
          }
          const { request: _request, startedAt: _startedAt, doneAt: _doneAt, frames: _frames, ...status } = task;
          return status;
        });
        // the busy counter of the whole instance since it booted: 2 vCPUs busy, whatever the number of tasks
        return Response.json({ tasks, cpuSeconds: (2 * (now - instance.bootAt)) / 1000, uptimeSeconds: (now - instance.bootAt) / 1000 });
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
  const storage: Storage = { presignPut: async (key) => `put:${key}`, presignGet: async (key) => `get:${key}` };
  const percents: number[] = [];
  const run = async (job: JobState, limitMs = 30 * 60_000, withStorage = false) => {
    while (job.phase !== 'done' && job.phase !== 'failed' && now < limitMs) { await step(job, fleet, withStorage ? storage : null, now); percents.push(progressOf(job, now).overallProgress); now += 1500; }
    return job;
  };
  return { fleet, run, destroyed, started, stored, percents, time: () => now };
}

const request = (fleet = {}) => ({ render: { composition: 'Test' }, fleet: { instances: 2, processesPerInstance: 2, ...fleet } });
const kinds = (job: JobState) => job.errors.map((error) => error.kind);

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

test('"no instance available" is not ready yet: nothing fails, nothing is counted, no spare instances are started', async () => {
  const sim = simulate({ unavailableUntil: 90_000 });
  const job = await sim.run(createJob('job11', request()));
  assert.equal(job.phase, 'done');
  assert.ok(job.chunks.every((chunk) => chunk.attempts === 0 && !chunk.lost));
  assert.equal(job.instances.length, 2);
  assert.deepEqual(job.errors, []);
});

test('a plan that answers 500 is asked again; a 4xx is the engine\'s answer and ends the job', async () => {
  const flaky = simulate({ planAnswers: [500, 500] });
  const job = await flaky.run(createJob('job12', request()));
  assert.equal(job.phase, 'done');
  assert.equal(kinds(job).filter((kind) => kind === 'plan_error').length, 2);
  const wrong = simulate({ planAnswers: [422] });
  const failed = await wrong.run(createJob('job13', request()));
  assert.equal(failed.phase, 'failed');
  assert.match(failed.errors.at(-1)!.message, /no such composition/);
});

test('a hanging chunk passes its deadline, its instance is replaced, the chunk is rendered again', async () => {
  const sim = simulate({ hang: /chunk-0001-r1$/ });
  const job = await sim.run(createJob('job4', request({ chunkDeadlineSeconds: 20, duplicateStragglers: false })));
  assert.equal(job.phase, 'done');
  assert.equal(job.chunks[1]!.attempts, 1);
  assert.equal(job.chunks[1]!.run, 2);
  assert.ok(kinds(job).includes('chunk_deadline'));
  assert.ok(sim.destroyed.length >= 1);
});

test('a chunk that stops making frames is replaced long before its deadline', async () => {
  const sim = simulate({ stall: /chunk-0002-r1$/ });
  const job = await sim.run(createJob('job14', request({ chunkDeadlineSeconds: 400, duplicateStragglers: false })));
  assert.equal(job.phase, 'done');
  assert.ok(kinds(job).includes('chunk_hung'));
  assert.ok(sim.time() < 300_000, `ended after ${sim.time()} ms, the deadline alone would have taken 400 s`);
});

test('hedging: a run with no frame gets a second run on a free slot and the first result wins', async () => {
  const sim = simulate({ hang: /chunk-0003-r1$/ });
  const job = await sim.run(createJob('job5', request({ chunkDeadlineSeconds: 600 })));
  assert.equal(job.phase, 'done');
  assert.deepEqual(progressOf(job).hedges, { started: 1, won: 1 });
  assert.ok(kinds(job).includes('hedge_started') && kinds(job).includes('hedge_won'));
  assert.equal(job.chunks[3]!.run, 2);
  assert.ok(sim.time() < 120_000);
});

test('hedging: only a measurably slow run, once per chunk, and never more than 5 % of the chunks', async () => {
  // 20 chunks; the last two run 12 times slower than the others. The cap is ceil(5 % of 20) = 1.
  const plan = { fps: 30, durationInFrames: 20 * 60, width: 1920, height: 1080, chunkable: true };
  const sim = simulate({ slow: { match: /chunk-00(18|19)-r1$/, factor: 12 } }, plan);
  const job = await sim.run(createJob('job15', request({ framesPerChunk: 60, chunkDeadlineSeconds: 600 })));
  assert.equal(job.phase, 'done');
  assert.equal(job.hedges, 1);
  assert.equal(sim.started.filter((task) => task.kind === 'chunk').length, 21);
  // a run that is only somewhat slower than the median is left alone
  const mild = simulate({ slow: { match: /chunk-0019-r1$/, factor: 1.8 } }, plan);
  const calm = await mild.run(createJob('job16', request({ framesPerChunk: 60 })));
  assert.equal(calm.hedges, 0);
  assert.equal(mild.started.filter((task) => task.kind === 'chunk').length, 20);
  // and hedging can be switched off
  const off = simulate({ slow: { match: /chunk-0019-r1$/, factor: 12 } }, plan);
  assert.equal((await off.run(createJob('job17', request({ framesPerChunk: 60, duplicateStragglers: false })))).hedges, 0);
});

test('every run writes its own files and keys; the stitcher gets the keys of the runs that won', async () => {
  const sim = simulate({ hang: /chunk-0003-r1$/, failTask: /chunk-0001-r1$/ });
  const job = await sim.run(createJob('job18', request({ chunkDeadlineSeconds: 600 })), 30 * 60_000, true);
  assert.equal(job.phase, 'done');
  const uploads = sim.started.filter((task) => task.kind === 'chunk').flatMap((task) => Object.values(task.upload!));
  assert.equal(new Set(uploads).size, uploads.length, 'two runs were given the same object key');
  const stitch = sim.started.find((task) => task.kind === 'stitch')!;
  assert.deepEqual(stitch.chunks!.map((chunk) => chunk.files[0]!.name), ['chunk-0000-r1.ts', 'chunk-0001-r2.ts', 'chunk-0002-r1.ts', 'chunk-0003-r2.ts']);
  assert.equal(stitch.download!['chunk-0003-r2.ts'], 'get:renders/job18/chunk-0003-r2.ts');
  assert.match(job.output!.key!, /^renders\/job18\/output-s0-0$/);
});

test('an engine with its own chunk files and chunks of any length (HyperFrames): its names are presigned, chunks of equal cost (heavy ranges shorter), the stitcher gets every chunk\'s frames', async () => {
  const plan: Plan = { fps: 30, durationInFrames: 1800, width: 1920, height: 1080, chunkable: true, chunkFiles: ['.ts', '.json'], variableChunks: true, segments: [{ startFrame: 600, endFrame: 1200, cls: 'heavy' }] };
  const sim = simulate({}, plan);
  const job = await sim.run(createJob('job30', request({ chunks: 'auto' })), 30 * 60_000, true);
  assert.equal(job.phase, 'done');
  // 2 instances x 2 processes: 4 chunks of equal cost, the two inside the heavy range a third as long as the others
  assert.deepEqual(job.chunks.map((chunk) => chunk.endFrame - chunk.startFrame), [675, 225, 225, 675]);
  const first = sim.started.find((task) => task.kind === 'chunk')!;
  assert.deepEqual(Object.keys(first.upload!).sort(), [`${first.outputBase}.json`, `${first.outputBase}.ts`]);
  const stitch = sim.started.find((task) => task.kind === 'stitch')!;
  assert.deepEqual(stitch.chunks!.map((chunk) => [chunk.startFrame, chunk.endFrame]), job.chunks.map((chunk) => [chunk.startFrame, chunk.endFrame]));
  assert.ok(stitch.chunks!.every((chunk) => chunk.files[1]!.name.endsWith('.json')));
});

test('an instance that restarts loses its tasks: the chunks are queued again and are not blamed for it', async () => {
  const sim = simulate({ restart: { instance: 'job6-0', at: 3000 } });
  const job = await sim.run(createJob('job6', request({ maxRetries: 0 })));
  assert.equal(job.phase, 'done');
  assert.ok(kinds(job).includes('instance_restarted'));
  assert.ok(job.chunks.every((chunk) => chunk.attempts === 0));
  assert.ok(job.chunks.some((chunk) => (chunk.lost ?? 0) === 1));
});

test('progress never goes backwards, also when rendered chunks are lost and rendered again', async () => {
  const sim = simulate({ restart: { instance: 'job19-0', at: 7000 }, corruptTransfers: 2 });
  const job = await sim.run(createJob('job19', request()));
  assert.equal(job.phase, 'done');
  for (let index = 1; index < sim.percents.length; index += 1) assert.ok(sim.percents[index]! >= sim.percents[index - 1]!, `${sim.percents[index - 1]} -> ${sim.percents[index]}`);
  assert.ok(sim.percents.slice(0, -1).every((percent) => percent < 1), 'only a finished job shows 1');
});

test('CPU is billed from each instance\'s own counter: tasks that share an instance are not counted twice, a restarted counter is not lost', async () => {
  // One instance, two chunks at the same time. The simulated instance is 2 vCPUs busy while it lives, and every task
  // reports those same 2 vCPUs for its own time, as the real task server does.
  const sim = simulate();
  const job = createJob('job20', request({ instances: 1 }));
  while (job.chunks.length === 0 || job.chunks.some((chunk) => chunk.state === 'pending' || chunk.state === 'running')) await sim.run(job, sim.time() + 1500);
  const seconds = sim.time() / 1000;
  const cpu = progressOf(job, sim.time()).costs.cpuSeconds;
  assert.ok(cpu <= 2 * seconds && cpu >= 2 * (seconds - 3), `${cpu} vCPU-s after ${seconds} s on one instance`);
  assert.equal(job.taskCpuSeconds, job.chunks.length * 2 * (TASK_MS / 1000), 'the tasks add up to twice what the instance used while they shared it');
  assert.ok(job.taskCpuSeconds > cpu);
  // A task server that restarts counts from 0 again. What it had used before is kept.
  const restarting = simulate({ restart: { instance: 'job23-1', at: 6000 } });
  const second = await restarting.run(createJob('job23', request()));
  const restarted = second.instances.find((instance) => instance.name === 'job23-1')!;
  assert.ok(restarted.cpuSeconds > (restarted.cpuCounter ?? 0), `${restarted.cpuSeconds} kept, the counter says ${restarted.cpuCounter}`);
});

test('a transfer that arrives damaged is repeated', async () => {
  const sim = simulate({ corruptTransfers: 1 });
  const job = await sim.run(createJob('job7', request()));
  assert.equal(job.phase, 'done');
  assert.ok(job.errors.some((error) => error.kind === 'checksum_mismatch' && /damaged/.test(error.message)));
});

test('a chunk that keeps failing fails the job with the reason', async () => {
  const sim = simulate({ failTask: /chunk-0002/ });
  const job = await sim.run(createJob('job8', request({ maxRetries: 1 })));
  assert.equal(job.phase, 'failed');
  assert.ok(progressOf(job).fatalErrorEncountered);
  assert.ok(job.errors.some((error) => /boom/.test(error.message)));
  assert.equal(job.errors.at(-1)!.kind, 'job_failed');
});

test('an engine that cannot chunk renders in one piece on one instance', async () => {
  const sim = simulate({}, { fps: 30, durationInFrames: 240, width: 1920, height: 1080, chunkable: false });
  const job = await sim.run(createJob('job9', request({ instances: 3 })));
  assert.equal(job.phase, 'done');
  assert.equal(job.chunks.length, 1);
  assert.equal(job.instances.length, 1);
});

test('a chunk that hangs everywhere, also as a hedge, still ends: instances are replaced until it renders', async () => {
  const sim = simulate({ hang: /chunk-0003-r[12]$/ });
  const job = await sim.run(createJob('job10', request({ chunkDeadlineSeconds: 30, maxRetries: 3 })));
  assert.equal(job.phase, 'done');
  assert.ok(kinds(job).filter((kind) => kind === 'chunk_deadline').length >= 1);
});

test('a coordinator that restarts continues from the stored job', async () => {
  const sim = simulate();
  let job = createJob('job21', request());
  for (let round = 0; round < 3; round += 1) await sim.run(job, sim.time() + 1500);
  // everything the coordinator knows is in the job: a copy made from JSON is as good as the original
  job = JSON.parse(JSON.stringify(job)) as JobState;
  await sim.run(job);
  assert.equal(job.phase, 'done');
  assert.equal(sim.started.filter((task) => task.kind === 'chunk').length, 4, 'no chunk was started twice');
});

test('every error entry has a kind that maps to a level and a fingerprint for an error tracker', async () => {
  const sim = simulate({ hang: /chunk-0001-r1$/, corruptTransfers: 1 });
  const job = await sim.run(createJob('job22', request({ chunkDeadlineSeconds: 20, duplicateStragglers: false })));
  assert.ok(job.errors.length >= 2);
  for (const error of job.errors) assert.ok(error.kind && EVENT_LEVELS[error.kind], `no level for ${error.kind}`);
  const event = toTrackerEvent(job.id, job.errors.find((error) => error.kind === 'chunk_deadline')!, { phase: 'rendering' });
  assert.equal(event.level, 'warning');
  assert.equal(event.fingerprint, 'chunk_deadline:rendering');
  assert.deepEqual({ chunk: event.properties.chunk, attempt: event.properties.attempt, fatal: event.properties.fatal }, { chunk: 1, attempt: 1, fatal: false });
});
