/**
 * The render coordinator: one job, many instances.
 *
 * It is a plain state machine. `step()` looks at the job, talks to the instances through a `Fleet`, changes the job and
 * returns. Call it every second or two until the phase is 'done' or 'failed'. It holds nothing in memory between calls,
 * so the same code runs in a Durable Object alarm (state in Durable Object storage) and in a local loop (state in a
 * variable). Every call is safe to repeat.
 *
 * What it handles, because each of these happened on real Cloudflare Containers:
 *   - an instance that is slow to start: chunks go to whichever instance answers, nobody waits for the slow one;
 *   - a chunk that hangs: per-chunk deadline, then the instance is replaced and the chunk rendered again;
 *   - an instance that restarts (deploy, host restart): its tasks are gone, the chunks are queued again;
 *   - a file that arrives with the right length and the wrong bytes: SHA-256 on both sides, transfer repeated;
 *   - a straggler: when a slot is free and nothing is queued, the slowest chunk is rendered a second time.
 */
import type { ChunkState, Fleet, FileInfo, InstanceState, JobRequest, JobState, RenderProgress, Storage, TaskRequest, TaskStatus } from './types.ts';

/** Cloudflare Containers list prices (developers.cloudflare.com/containers/platform/pricing, read 2026-11-27). */
export const PRICES = { vcpuSecond: 0.00002, gibSecond: 0.0000025, diskGbSecond: 0.00000007 };
/** standard-4 */
export const INSTANCE = { vcpu: 4, memoryGiB: 12, diskGB: 20 };
export const INSTANCE_SECOND_PRICE = INSTANCE.memoryGiB * PRICES.gibSecond + INSTANCE.diskGB * PRICES.diskGbSecond;

const MIN_FRAMES_PER_CHUNK = 30;
const MISSES_BEFORE_REPLACING = 20;
const START_DEADLINE_MS = 15 * 60_000;
const MAX_TRANSFERS_PER_STEP = 3;
const MAX_TRANSFER_ATTEMPTS = 3;
const MAX_STITCH_ATTEMPTS = 3;

export function createJob(id: string, request: JobRequest, now = Date.now()): JobState {
  return {
    id, request, phase: 'planning', createdAt: now, startFrame: 0, endFrame: 0, framesPerChunk: 0, chunks: [],
    instances: [], nextInstance: 0, errors: [], taskCpuSeconds: 0, taskWallSeconds: 0,
  };
}

const settings = (job: JobState) => {
  const fleet = job.request.fleet ?? {};
  return {
    instances: Math.max(1, Math.floor(fleet.instances ?? 1)),
    processes: Math.max(1, Math.floor(fleet.processesPerInstance ?? 3)),
    maxRetries: Math.max(0, fleet.maxRetries ?? 2),
    duplicateStragglers: fleet.duplicateStragglers ?? true,
  };
};

const chunkName = (index: number) => `chunk-${String(index).padStart(4, '0')}`;
const live = (job: JobState) => job.instances.filter((instance) => !instance.gone);
const note = (job: JobState, message: string, extra: { chunk?: number; instance?: string; fatal?: boolean } = {}) => {
  job.errors.push({ at: Date.now(), message, fatal: extra.fatal ?? false, ...(extra.chunk === undefined ? {} : { chunk: extra.chunk }), ...(extra.instance ? { instance: extra.instance } : {}) });
  if (job.errors.length > 60) job.errors.splice(0, job.errors.length - 60);
};
const fail = (job: JobState, message: string, now: number) => { note(job, message, { fatal: true }); job.phase = 'failed'; job.finishedAt = now; };

async function call(fleet: Fleet, instance: string, path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  return fleet.fetch(instance, path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`not JSON (${response.status}): ${text.slice(0, 200)}`); }
}

function addInstance(job: JobState, now: number): InstanceState {
  const instance: InstanceState = { name: `${job.id}-${job.nextInstance}`, startedAt: now, misses: 0, wallSeconds: 0, cpuSeconds: 0 };
  job.nextInstance += 1;
  job.instances.push(instance);
  return instance;
}

/** Takes an instance out of the job and puts back everything that only existed there. */
async function retire(job: JobState, fleet: Fleet, instance: InstanceState, now: number, reason: string | null) {
  if (instance.gone) return;
  instance.gone = true;
  instance.wallSeconds = (now - instance.startedAt) / 1000;
  if (reason) note(job, reason, { instance: instance.name });
  const wasStitcher = job.stitcher === instance.name;
  if (wasStitcher) { job.stitcher = undefined; job.stitchTask = undefined; }
  for (const chunk of job.chunks) {
    chunk.runs = chunk.runs.filter((run) => run.instance !== instance.name);
    if (!job.usesStorage) {
      const here = chunk.instance === instance.name;
      // Rendered here and not yet copied anywhere else, or copied only to a stitcher that is now gone: render again.
      if (here && (chunk.state === 'rendered' || (chunk.state === 'stored' && wasStitcher))) { chunk.state = 'pending'; chunk.instance = undefined; chunk.files = undefined; }
      // Stored on a stitcher that is gone. If the instance that rendered it is still there, send the files again;
      // if that one is gone too, render again.
      else if (wasStitcher && chunk.state === 'stored') {
        if (job.instances.some((other) => other.name === chunk.instance && !other.gone)) chunk.state = 'rendered';
        else { chunk.state = 'pending'; chunk.instance = undefined; chunk.files = undefined; }
      }
    }
    if (chunk.state === 'running' && chunk.runs.length === 0) chunk.state = 'pending';
  }
  if (wasStitcher && job.phase === 'stitching') job.phase = 'rendering';
  await fleet.destroy(instance.name).catch(() => undefined);
}

/** One round. Mutates and returns the job. */
export async function step(job: JobState, fleet: Fleet, storage: Storage | null = null, now = Date.now()): Promise<JobState> {
  job.usesStorage = Boolean(storage);
  try {
    if (job.phase === 'planning') await planning(job, fleet, now);
    else if (job.phase === 'rendering') await rendering(job, fleet, storage, now);
    else if (job.phase === 'stitching') await stitching(job, fleet, storage, now);
  } catch (error) {
    // A bug or an unexpected answer must not stop the loop: it is recorded, the next round tries again.
    note(job, `coordinator: ${error instanceof Error ? error.message : String(error)}`);
  }
  return job;
}

async function planning(job: JobState, fleet: Fleet, now: number) {
  const instance = live(job)[0] ?? addInstance(job, now);
  if (now - job.createdAt > START_DEADLINE_MS) return fail(job, 'no instance answered within 15 minutes', now);
  let response: Response;
  try { response = await call(fleet, instance.name, '/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ render: job.request.render }) }, 120_000); }
  catch { instance.misses += 1; return; }
  if (response.status >= 500 && response.status !== 500) { await response.body?.cancel(); instance.misses += 1; return; }
  if (!response.ok) return fail(job, `plan failed: ${(await response.text()).slice(0, 2000)}`, now);
  instance.readyAt ??= now;
  instance.misses = 0;
  const plan = await json<NonNullable<JobState['plan']>>(response);
  const config = settings(job);
  const render = job.request.render;
  const still = render.type === 'still';
  const range = still ? [Number(render.frame ?? 0), Number(render.frame ?? 0)] : render.frameRange ?? [0, plan.durationInFrames - 1];
  job.plan = plan;
  job.startFrame = Math.max(0, Math.min(plan.durationInFrames - 1, range[0]));
  job.endFrame = Math.max(job.startFrame + 1, Math.min(plan.durationInFrames, range[1] + 1));
  const frames = job.endFrame - job.startFrame;
  const wanted = job.request.fleet?.framesPerChunk ?? Math.ceil(frames / (config.instances * config.processes));
  job.framesPerChunk = Math.max(MIN_FRAMES_PER_CHUNK, Math.floor(wanted));
  job.single = still || !plan.chunkable || frames <= job.framesPerChunk;
  if (job.single) job.framesPerChunk = frames;
  job.chunks = [];
  for (let index = 0, from = job.startFrame; from < job.endFrame; index += 1, from += job.framesPerChunk) {
    job.chunks.push({ index, startFrame: from, endFrame: Math.min(job.endFrame, from + job.framesPerChunk), state: 'pending', attempts: 0, runs: [], transferAttempts: 0 });
  }
  job.phase = 'rendering';
}

const deadlineSeconds = (job: JobState, chunk: ChunkState) => job.request.fleet?.chunkDeadlineSeconds ?? Math.max(300, (chunk.endFrame - chunk.startFrame) / 1.5);

async function poll(job: JobState, fleet: Fleet, now: number): Promise<Map<string, Map<string, TaskStatus>>> {
  const answers = new Map<string, Map<string, TaskStatus>>();
  await Promise.all(live(job).map(async (instance) => {
    try {
      const response = await call(fleet, instance.name, `/tasks?job=${job.id}`);
      if (!response.ok) { await response.body?.cancel(); throw new Error(String(response.status)); }
      const body = await json<{ tasks: TaskStatus[]; cpuSeconds: number; uptimeSeconds: number }>(response);
      instance.readyAt ??= now;
      instance.misses = 0;
      instance.cpuSeconds = body.cpuSeconds;
      answers.set(instance.name, new Map(body.tasks.map((task) => [task.id, task])));
    } catch { instance.misses += 1; }
  }));
  return answers;
}

async function rendering(job: JobState, fleet: Fleet, storage: Storage | null, now: number) {
  const config = settings(job);
  const plan = job.plan!;
  // Enough instances for the work that is left, never more than asked for.
  const unfinished = job.chunks.filter((chunk) => chunk.state === 'pending' || chunk.state === 'running').length;
  const wantedInstances = Math.min(config.instances, Math.ceil(unfinished / config.processes));
  while (live(job).length < wantedInstances && job.nextInstance < config.instances * 3 + 2) addInstance(job, now);

  const answers = await poll(job, fleet, now);
  for (const instance of live(job)) {
    const silentTooLong = instance.readyAt ? instance.misses > MISSES_BEFORE_REPLACING : now - instance.startedAt > START_DEADLINE_MS;
    if (silentTooLong) await retire(job, fleet, instance, now, instance.readyAt ? 'instance stopped answering: replaced' : 'instance never started: replaced');
  }

  // What happened to the running chunks.
  for (const chunk of job.chunks) {
    for (const run of [...chunk.runs]) {
      const tasks = answers.get(run.instance);
      if (!tasks) continue; // no answer this round: decided by the miss counter above
      const task = tasks.get(run.taskId);
      const drop = () => { chunk.runs = chunk.runs.filter((other) => other !== run); };
      if (!task) { drop(); chunk.attempts += 1; note(job, 'task lost: the instance restarted', { chunk: chunk.index, instance: run.instance }); continue; }
      run.framesRendered = task.framesRendered;
      if (task.state === 'failed') { drop(); chunk.attempts += 1; note(job, `render failed: ${task.error ?? 'unknown error'}`, { chunk: chunk.index, instance: run.instance }); continue; }
      if (task.state === 'done' && chunk.state === 'running') {
        if (storage && !task.uploaded) continue; // still uploading
        chunk.state = storage ? 'stored' : 'rendered';
        chunk.instance = run.instance;
        chunk.files = storage ? task.files.map((file) => ({ ...file })) : task.files;
        chunk.renderSeconds = task.wallSeconds;
        job.taskCpuSeconds += task.cpuSeconds ?? 0;
        job.taskWallSeconds += task.wallSeconds ?? 0;
        // A duplicate of this chunk is no longer needed.
        for (const other of chunk.runs) if (other !== run) void call(fleet, other.instance, `/tasks/${other.taskId}`, { method: 'DELETE' }).then((r) => r.body?.cancel(), () => undefined);
        chunk.runs = [];
        continue;
      }
      if (task.state === 'running' && (now - run.startedAt) / 1000 > deadlineSeconds(job, chunk)) {
        drop(); chunk.attempts += 1;
        const instance = job.instances.find((candidate) => candidate.name === run.instance);
        if (instance) await retire(job, fleet, instance, now, `chunk ${chunk.index} passed its deadline: instance replaced`);
      }
    }
    if (chunk.state === 'running' && chunk.runs.length === 0) chunk.state = 'pending';
    if (chunk.attempts > config.maxRetries) return fail(job, `chunk ${chunk.index} failed ${chunk.attempts} times`, now);
  }

  // Hand out work to instances that answered this round.
  const free = live(job).filter((instance) => answers.has(instance.name)).map((instance) => ({ instance, slots: config.processes - job.chunks.reduce((sum, chunk) => sum + chunk.runs.filter((run) => run.instance === instance.name).length, 0) }));
  const start = async (chunk: ChunkState, instance: InstanceState) => {
    const base = chunkName(chunk.index);
    const taskId = `${job.id}-${base}-a${chunk.attempts}-${instance.name.split('-').pop()}`;
    const names = job.single ? null : [`${base}.ts`, `${base}.aac`];
    const upload: Record<string, string> = {};
    if (storage && names) for (const name of names) upload[name] = await storage.presignPut(`renders/${job.id}/${name}`);
    if (storage && job.single) upload['*'] = await storage.presignPut(`renders/${job.id}/output`);
    const task: TaskRequest = {
      id: taskId, jobId: job.id, kind: job.request.render.type === 'still' ? 'still' : job.single ? 'single' : 'chunk', render: job.request.render, plan,
      startFrame: chunk.startFrame, endFrame: chunk.endFrame, compositionStart: job.startFrame, chunkIndex: chunk.index, processes: config.processes,
      ...(storage ? { upload } : {}),
    };
    try {
      const response = await call(fleet, instance.name, '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
      await response.body?.cancel();
      if (!response.ok) return false;
    } catch { return false; }
    chunk.runs.push({ instance: instance.name, taskId, startedAt: now, framesRendered: 0 });
    chunk.state = 'running';
    return true;
  };
  for (const slot of free) {
    while (slot.slots > 0) {
      const chunk = job.chunks.find((candidate) => candidate.state === 'pending');
      if (!chunk || !(await start(chunk, slot.instance))) break;
      slot.slots -= 1;
    }
  }
  // Stragglers: nothing queued, a slot free, one chunk far behind the others. Render it twice, keep the first result.
  if (config.duplicateStragglers && !job.chunks.some((chunk) => chunk.state === 'pending')) {
    const times = job.chunks.map((chunk) => chunk.renderSeconds).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    if (times.length >= 2 && median) {
      for (const slot of free) {
        if (slot.slots <= 0) continue;
        const straggler = job.chunks.find((chunk) => chunk.state === 'running' && chunk.runs.length === 1 && chunk.runs[0]!.instance !== slot.instance.name && (now - chunk.runs[0]!.startedAt) / 1000 > Math.max(30, median * 2));
        if (straggler && (await start(straggler, slot.instance))) { slot.slots -= 1; note(job, 'straggler: second copy started', { chunk: straggler.index, instance: slot.instance.name }); }
      }
    }
  }

  // Bring rendered chunks to one place. With storage the container uploaded them itself.
  if (!storage && !job.single) {
    const rendered = job.chunks.filter((chunk) => chunk.state === 'rendered');
    if (!job.stitcher && rendered[0]) job.stitcher = rendered[0].instance;
    const moving: Promise<void>[] = [];
    for (const chunk of rendered) {
      if (chunk.instance === job.stitcher) { chunk.state = 'stored'; continue; }
      if (moving.length >= MAX_TRANSFERS_PER_STEP) continue;
      moving.push(transfer(job, fleet, chunk));
    }
    await Promise.all(moving);
  }

  const finished = job.chunks.every((chunk) => chunk.state === 'stored' || (job.single && chunk.state === 'rendered'));
  if (!finished) return;
  if (job.single) {
    const chunk = job.chunks[0]!;
    const file = chunk.files![0]!;
    chunk.state = 'stored';
    job.output = { ...file, ...(storage ? { key: `renders/${job.id}/output` } : { instance: chunk.instance! }) };
    return finish(job, fleet, now);
  }
  if (storage) job.stitcher = live(job).find((instance) => answers.has(instance.name))?.name ?? live(job)[0]?.name;
  if (!job.stitcher) { addInstance(job, now); return; }
  job.phase = 'stitching';
  // Instances that hold nothing the stitcher still needs are stopped now: an idle instance bills memory until it sleeps.
  for (const instance of live(job)) if (instance.name !== job.stitcher) await retire(job, fleet, instance, now, null);
}

/** No object storage: one file from the instance that rendered it into the stitcher, through the coordinator, hash checked. */
async function transfer(job: JobState, fleet: Fleet, chunk: ChunkState) {
  try {
    for (const file of chunk.files!) {
      const source = await fleet.fetch(chunk.instance!, `/files/${job.id}/${file.name}`, { signal: AbortSignal.timeout(300_000) });
      if (!source.ok || !source.body) { await source.body?.cancel(); throw new Error(`read ${file.name}: ${source.status}`); }
      const stored = await fleet.fetch(job.stitcher!, `/files/${job.id}/${file.name}`, { method: 'PUT', body: source.body, headers: { 'content-length': String(file.bytes) }, signal: AbortSignal.timeout(300_000), duplex: 'half' } as RequestInit);
      const receipt = stored.ok ? await json<FileInfo>(stored) : null;
      if (!receipt) { await stored.body?.cancel(); throw new Error(`write ${file.name}: ${stored.status}`); }
      if (receipt.sha256 !== file.sha256 || receipt.bytes !== file.bytes) throw new Error(`${file.name} arrived damaged (${receipt.bytes} bytes, hash differs)`);
    }
    chunk.state = 'stored';
  } catch (error) {
    chunk.transferAttempts += 1;
    note(job, `transfer: ${error instanceof Error ? error.message : String(error)}`, { chunk: chunk.index, instance: chunk.instance });
    if (chunk.transferAttempts >= MAX_TRANSFER_ATTEMPTS) { chunk.state = 'pending'; chunk.transferAttempts = 0; chunk.attempts += 1; chunk.instance = undefined; chunk.files = undefined; }
  }
}

async function stitching(job: JobState, fleet: Fleet, storage: Storage | null, now: number) {
  const stitcher = job.instances.find((instance) => instance.name === job.stitcher && !instance.gone);
  if (!stitcher) { job.phase = 'rendering'; return; }
  if (!job.stitchTask) {
    const attempts = job.errors.filter((error) => error.message.startsWith('stitch')).length;
    if (attempts >= MAX_STITCH_ATTEMPTS) return fail(job, 'stitching failed 3 times', now);
    const id = `${job.id}-stitch-${attempts}`;
    const download: Record<string, string> = {};
    const upload: Record<string, string> = {};
    if (storage) {
      for (const chunk of job.chunks) for (const file of chunk.files!) download[file.name] = await storage.presignGet(`renders/${job.id}/${file.name}`);
      upload['*'] = await storage.presignPut(`renders/${job.id}/output`);
    }
    const task: TaskRequest = { id, jobId: job.id, kind: 'stitch', render: job.request.render, plan: job.plan!, startFrame: job.startFrame, endFrame: job.endFrame, framesPerChunk: job.framesPerChunk, chunkCount: job.chunks.length, ...(storage ? { download, upload } : {}) };
    try {
      const response = await call(fleet, stitcher.name, '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
      await response.body?.cancel();
      if (response.ok) job.stitchTask = { id, startedAt: now, attempts };
      else stitcher.misses += 1;
    } catch { stitcher.misses += 1; }
    if (stitcher.misses > MISSES_BEFORE_REPLACING) await retire(job, fleet, stitcher, now, 'stitch: the instance stopped answering');
    return;
  }
  const answers = await poll(job, fleet, now);
  const tasks = answers.get(stitcher.name);
  if (!tasks) { if (stitcher.misses > MISSES_BEFORE_REPLACING) await retire(job, fleet, stitcher, now, 'stitch: the instance stopped answering'); return; }
  const task = tasks.get(job.stitchTask.id);
  if (!task) { await retire(job, fleet, stitcher, now, 'stitch: task lost, the instance restarted'); return; }
  if (task.state === 'failed') { note(job, `stitch failed: ${task.error ?? 'unknown error'}`, { instance: stitcher.name }); job.stitchTask = undefined; return; }
  if (task.state === 'running') { if ((now - job.stitchTask.startedAt) / 1000 > 900) await retire(job, fleet, stitcher, now, 'stitch: no result after 15 minutes'); return; }
  if (storage && !task.uploaded) return;
  job.output = { ...task.files[0]!, ...(storage ? { key: `renders/${job.id}/output` } : { instance: stitcher.name }) };
  await finish(job, fleet, now);
}

async function finish(job: JobState, fleet: Fleet, now: number) {
  job.phase = 'done';
  job.finishedAt = now;
  // Keep only the instance that holds the output (no storage). It is destroyed by cleanup() or by its inactivity timeout.
  for (const instance of live(job)) if (instance.name !== job.output?.instance) await retire(job, fleet, instance, now, null);
}

/** Stops every instance of the job. Call after the output was downloaded, or to cancel. */
export async function cleanup(job: JobState, fleet: Fleet, now = Date.now()) {
  for (const instance of live(job)) await retire(job, fleet, instance, now, null);
  if (job.phase !== 'done' && job.phase !== 'failed') { job.phase = 'failed'; job.finishedAt = now; note(job, 'cancelled', { fatal: true }); }
}

export function progressOf(job: JobState, now = Date.now()): RenderProgress {
  const frames = Math.max(1, job.endFrame - job.startFrame);
  const framesRendered = job.chunks.reduce((sum, chunk) => sum + (chunk.state === 'rendered' || chunk.state === 'stored' ? chunk.endFrame - chunk.startFrame : Math.min(chunk.endFrame - chunk.startFrame, Math.max(0, ...chunk.runs.map((run) => run.framesRendered)))), 0);
  const stored = job.chunks.filter((chunk) => chunk.state === 'stored').length;
  const done = job.phase === 'done';
  // Frames are 90 % of the work, bringing the chunks together 5 %, the join 5 %.
  const overall = done ? 1 : job.chunks.length === 0 ? 0 : 0.9 * (framesRendered / frames) + 0.05 * (job.single ? framesRendered / frames : stored / job.chunks.length) + (job.phase === 'stitching' ? 0.02 : 0);
  const instanceSeconds = job.instances.reduce((sum, instance) => sum + (instance.gone ? instance.wallSeconds : ((job.finishedAt ?? now) - instance.startedAt) / 1000), 0);
  const cpuSeconds = job.instances.reduce((sum, instance) => sum + instance.cpuSeconds, 0);
  return {
    renderId: job.id, done, overallProgress: Math.min(1, Math.round(overall * 1000) / 1000), phase: job.phase, framesRendered, frames,
    chunks: { total: job.chunks.length, rendered: job.chunks.filter((chunk) => chunk.state === 'rendered' || chunk.state === 'stored').length, stored, running: job.chunks.filter((chunk) => chunk.state === 'running').length },
    instances: live(job).length,
    fatalErrorEncountered: job.phase === 'failed', errors: job.errors,
    outputFile: job.output?.name ?? null, outputSizeInBytes: job.output?.bytes ?? null, outputSha256: job.output?.sha256 ?? null,
    timeToFinish: job.finishedAt ? job.finishedAt - job.createdAt : null,
    costs: {
      accruedSoFar: Math.round((cpuSeconds * PRICES.vcpuSecond + instanceSeconds * INSTANCE_SECOND_PRICE) * 1e6) / 1e6, currency: 'USD', cpuSeconds: Math.round(cpuSeconds * 10) / 10, instanceSeconds: Math.round(instanceSeconds * 10) / 10,
      disclaimer: 'Estimate at list price from CPU time measured inside the instances and instance lifetime seen by the coordinator (standard-4). Not read from the Cloudflare bill. Idle time after the render is not included.',
    },
  };
}
