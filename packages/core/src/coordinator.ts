/**
 * The render coordinator: one job, many instances.
 *
 * It is a plain state machine. `step()` looks at the job, talks to the instances through a `Fleet`, changes the job and
 * returns. Call it every second or two until the phase is 'done' or 'failed'. It holds nothing in memory between calls,
 * so the same code runs in a Durable Object alarm (state in Durable Object storage) and in a local loop (state in a
 * variable). Every call is safe to repeat, and a coordinator that restarts continues from the stored job.
 *
 * What it handles, because each of these happened on real Cloudflare Containers:
 *   - an instance that is slow to start: chunks go to whichever instance answers, nobody waits for the whole fleet;
 *   - "no instance available" and other 5xx answers while an instance is provided: not ready yet, never a failed chunk;
 *   - a chunk that hangs: per-chunk deadline and a no-progress limit, then the instance is replaced and the chunk
 *     rendered again;
 *   - an instance that restarts (deploy, host restart): its tasks are gone, the chunks are queued again, and that does
 *     not count against the chunk;
 *   - a file that arrives with the right length and the wrong bytes: SHA-256 on both sides, transfer repeated;
 *   - a slow run: a second run ("hedge") only for a chunk that is measurably slow, once per chunk, for a small share
 *     of the chunks. Every run writes its own files, so a run that finishes late cannot overwrite the one that won.
 */
import type { ChunkRun, ChunkState, EventKind, Fleet, FileInfo, InstanceState, JobRequest, JobState, RenderProgress, Storage, TaskRequest, TaskStatus } from './types.ts';

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
const MAX_STITCHERS_LOST = 6;
const MAX_PLAN_FAILURES = 5;
/** A chunk without a new frame for this long is hung, whatever its deadline says. */
const HUNG_SECONDS = 150;
/** Hedging: finished chunks needed before "slow" means anything, and how long a run is left alone at least. */
const HEDGE_MIN_SAMPLES = 3;
const HEDGE_GRACE_SECONDS = 20;

export function createJob(id: string, request: JobRequest, now = Date.now()): JobState {
  return {
    id, request, phase: 'planning', createdAt: now, startFrame: 0, endFrame: 0, framesPerChunk: 0, chunks: [],
    instances: [], nextInstance: 0, errors: [], taskCpuSeconds: 0, taskWallSeconds: 0, hedges: 0, hedgesWon: 0, progressHigh: 0,
  };
}

const settings = (job: JobState) => {
  const fleet = job.request.fleet ?? {};
  return {
    instances: Math.max(1, Math.floor(fleet.instances ?? 1)),
    processes: Math.max(1, Math.floor(fleet.processesPerInstance ?? 3)),
    maxRetries: Math.max(0, fleet.maxRetries ?? 2),
    duplicateStragglers: fleet.duplicateStragglers ?? true,
    maxHedgeShare: Math.max(0, Math.min(1, fleet.maxHedgeShare ?? 0.05)),
    stitch: fleet.stitch ?? 'combine',
  };
};

const chunkName = (index: number) => `chunk-${String(index).padStart(4, '0')}`;
/** Where a file of a render lives in object storage. Every run has its own file names, so every run has its own keys. */
export const objectKey = (jobId: string, name: string) => `renders/${jobId}/${name}`;
const live = (job: JobState) => job.instances.filter((instance) => !instance.gone);
const median = (values: number[]) => { const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null; };
const note = (job: JobState, kind: EventKind, message: string, extra: { chunk?: number; attempt?: number; instance?: string; fatal?: boolean } = {}) => {
  job.errors.push({ at: Date.now(), kind, message, fatal: extra.fatal ?? false, ...(extra.chunk === undefined ? {} : { chunk: extra.chunk }), ...(extra.attempt === undefined ? {} : { attempt: extra.attempt }), ...(extra.instance ? { instance: extra.instance } : {}) });
  if (job.errors.length > 60) job.errors.splice(0, job.errors.length - 60);
};
const fail = (job: JobState, message: string, now: number) => { note(job, 'job_failed', message, { fatal: true }); job.phase = 'failed'; job.finishedAt = now; };

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
async function retire(job: JobState, fleet: Fleet, instance: InstanceState, now: number, reason: { kind: EventKind; message: string } | null) {
  if (instance.gone) return;
  instance.gone = true;
  instance.wallSeconds = (now - instance.startedAt) / 1000;
  if (reason) note(job, reason.kind, reason.message, { instance: instance.name });
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
    note(job, 'coordinator_error', `coordinator: ${error instanceof Error ? error.message : String(error)}`);
  }
  job.progressHigh = progressOf(job, now).overallProgress;
  return job;
}

async function planning(job: JobState, fleet: Fleet, now: number) {
  const instance = live(job)[0] ?? addInstance(job, now);
  if (now - job.createdAt > START_DEADLINE_MS) return fail(job, 'no instance answered within 15 minutes', now);
  let response: Response;
  try { response = await call(fleet, instance.name, '/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ render: job.request.render }) }, 120_000); }
  catch { instance.misses += 1; return; }
  // 4xx is the engine's answer about the request (an unknown composition): final. 5xx is the platform or a crash on the
  // way ("no Container instance available", "Error proxying request to container"): tried again, without limit while
  // the instance is still being provided, a few times when the answer was a plain 500.
  if (response.status >= 500) {
    const text = (await response.text().catch(() => '')).slice(0, 2000);
    instance.misses += 1;
    if (response.status !== 500) return;
    job.planFailures = (job.planFailures ?? 0) + 1;
    if (job.planFailures >= MAX_PLAN_FAILURES) return fail(job, `plan failed ${job.planFailures} times: ${text}`, now);
    return note(job, 'plan_error', `plan answered 500, trying again: ${text.slice(0, 300)}`, { instance: instance.name });
  }
  if (!response.ok) return fail(job, `plan failed: ${(await response.text()).slice(0, 2000)}`, now);
  instance.readyAt ??= now;
  instance.misses = 0;
  const plan = await json<NonNullable<JobState['plan']>>(response);
  const config = settings(job);
  const render = job.request.render;
  const still = render.type === 'still';
  const range = still ? [Number(render.frame ?? 0), Number(render.frame ?? 0)] : render.frameRange ?? [0, plan.durationInFrames - 1];
  job.plan = plan;
  job.startFrame = Math.max(0, Math.min(plan.durationInFrames - 1, range[0]!));
  job.endFrame = Math.max(job.startFrame + 1, Math.min(plan.durationInFrames, range[1]! + 1));
  const frames = job.endFrame - job.startFrame;
  const wanted = job.request.fleet?.framesPerChunk ?? Math.ceil(frames / (config.instances * config.processes));
  job.framesPerChunk = Math.max(MIN_FRAMES_PER_CHUNK, Math.floor(wanted));
  job.single = still || !plan.chunkable || frames <= job.framesPerChunk;
  if (job.single) job.framesPerChunk = frames;
  job.chunks = [];
  for (let index = 0, from = job.startFrame; from < job.endFrame; index += 1, from += job.framesPerChunk) {
    job.chunks.push({ index, startFrame: from, endFrame: Math.min(job.endFrame, from + job.framesPerChunk), state: 'pending', attempts: 0, lost: 0, runsStarted: 0, runs: [], transferAttempts: 0 });
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
      // The bill follows the instance's own busy counter. Adding up what the tasks report would count an instance
      // twice when two tasks share it. The counter starts again from 0 when the task server restarts.
      const last = instance.cpuCounter ?? instance.cpuSeconds;
      instance.cpuSeconds += body.cpuSeconds >= last ? body.cpuSeconds - last : body.cpuSeconds;
      instance.cpuCounter = body.cpuSeconds;
      answers.set(instance.name, new Map(body.tasks.map((task) => [task.id, task])));
    } catch { instance.misses += 1; }
  }));
  return answers;
}

/** A finished chunk task must bring what was asked for, or it is treated as a failed run. */
function refusal(job: JobState, task: TaskStatus): string | null {
  const wanted = job.single ? 1 : 2;
  if (task.files.length < wanted) return `${task.files.length} files instead of ${wanted}`;
  if (!job.single && !(task.files[0]!.bytes > 0)) return 'empty video file';
  return null;
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
    // An instance that has never answered is being provided: it gets 15 minutes and nothing is counted against anybody
    // meanwhile. One that did answer and then stayed silent for 20 rounds is replaced.
    const silentTooLong = instance.readyAt ? instance.misses > MISSES_BEFORE_REPLACING : now - instance.startedAt > START_DEADLINE_MS;
    if (silentTooLong) await retire(job, fleet, instance, now, instance.readyAt ? { kind: 'instance_unresponsive', message: 'instance stopped answering: replaced' } : { kind: 'instance_start_failed', message: 'instance never started: replaced' });
  }

  // What happened to the running chunks.
  for (const chunk of job.chunks) {
    for (const run of [...chunk.runs]) {
      const tasks = answers.get(run.instance);
      if (!tasks) continue; // no answer this round: decided by the miss counter above
      const task = tasks.get(run.taskId);
      const drop = () => { chunk.runs = chunk.runs.filter((other) => other !== run); };
      const where = { chunk: chunk.index, attempt: run.run, instance: run.instance };
      // Not the chunk's fault: counted apart from `attempts`, with a limit of its own.
      if (!task) { drop(); chunk.lost = (chunk.lost ?? 0) + 1; note(job, 'instance_restarted', 'task lost: the instance restarted', where); continue; }
      if (task.framesRendered !== run.framesRendered) { run.framesRendered = task.framesRendered; run.progressAt = now; }
      if (task.framesRendered > 0) run.firstFrameAt ??= now;
      if (task.state === 'failed') { drop(); chunk.attempts += 1; note(job, 'chunk_failed', `render failed: ${task.error ?? 'unknown error'}`, where); continue; }
      if (task.state === 'done' && chunk.state === 'running') {
        if (storage && !task.uploaded) continue; // still uploading
        const refused = refusal(job, task);
        if (refused) { drop(); chunk.attempts += 1; note(job, 'chunk_failed', `result refused: ${refused}`, where); continue; }
        chunk.state = storage ? 'stored' : 'rendered';
        chunk.instance = run.instance;
        chunk.run = run.run;
        chunk.files = task.files.map((file) => ({ ...file }));
        const frames = chunk.endFrame - chunk.startFrame;
        const wall = task.wallSeconds ?? (now - run.startedAt) / 1000;
        chunk.renderSeconds = wall;
        chunk.firstFrameSeconds = run.firstFrameAt ? (run.firstFrameAt - run.startedAt) / 1000 : undefined;
        chunk.fps = frames / Math.max(0.5, wall - (chunk.firstFrameSeconds ?? 0));
        job.taskCpuSeconds += task.cpuSeconds ?? 0;
        job.taskWallSeconds += wall;
        if (run.hedge) { job.hedgesWon = (job.hedgesWon ?? 0) + 1; note(job, 'hedge_won', 'hedge: the second run finished first', where); }
        // The other run lost the race. It is stopped; whatever it already wrote has its own name and is never used.
        for (const other of chunk.runs) if (other !== run) void call(fleet, other.instance, `/tasks/${other.taskId}`, { method: 'DELETE' }).then((r) => r.body?.cancel(), () => undefined);
        chunk.runs = [];
        continue;
      }
      if (task.state !== 'running') continue;
      const deadline = deadlineSeconds(job, chunk);
      const age = (now - run.startedAt) / 1000;
      const quiet = (now - (run.progressAt ?? run.startedAt)) / 1000;
      // A whole render in one task (HyperFrames, a still) reports stages, not frames: only its deadline counts.
      const hung = !job.single && quiet > Math.max(HUNG_SECONDS, deadline / 2);
      if (age > deadline || hung) {
        drop(); chunk.attempts += 1;
        const message = age > deadline ? `chunk ${chunk.index} passed its deadline of ${Math.round(deadline)} s at frame ${run.framesRendered}: instance replaced` : `chunk ${chunk.index} made no progress for ${Math.round(quiet)} s at frame ${run.framesRendered}: instance replaced`;
        note(job, age > deadline ? 'chunk_deadline' : 'chunk_hung', message, where);
        // The instance is not trusted any more. Whatever else ran there is queued again without blame.
        const instance = job.instances.find((candidate) => candidate.name === run.instance);
        if (instance) await retire(job, fleet, instance, now, null);
      }
    }
    if (chunk.state === 'running' && chunk.runs.length === 0) chunk.state = 'pending';
    if (chunk.attempts > config.maxRetries) return fail(job, `chunk ${chunk.index} failed ${chunk.attempts} times`, now);
    if ((chunk.lost ?? 0) > 3 * (config.maxRetries + 1)) return fail(job, `chunk ${chunk.index} lost its instance ${chunk.lost} times`, now);
  }

  // Hand out work to instances that answered this round. The queue feeds whoever is there: a fleet that arrives one
  // instance at a time renders from the first second.
  const free = live(job).filter((instance) => answers.has(instance.name)).map((instance) => ({ instance, slots: config.processes - job.chunks.reduce((sum, chunk) => sum + chunk.runs.filter((run) => run.instance === instance.name).length, 0) }));
  const start = async (chunk: ChunkState, instance: InstanceState, hedge = false) => {
    const run = (chunk.runsStarted ?? 0) + 1;
    const base = job.single ? null : `${chunkName(chunk.index)}-r${run}`;
    const taskId = `${job.id}-${chunkName(chunk.index)}-r${run}`;
    const upload: Record<string, string> = {};
    if (storage && base) for (const name of [`${base}.ts`, `${base}.aac`]) upload[name] = await storage.presignPut(objectKey(job.id, name));
    if (storage && !base) upload['*'] = await storage.presignPut(objectKey(job.id, `output-r${run}`));
    const task: TaskRequest = {
      id: taskId, jobId: job.id, kind: job.request.render.type === 'still' ? 'still' : job.single ? 'single' : 'chunk', render: job.request.render, plan,
      startFrame: chunk.startFrame, endFrame: chunk.endFrame, compositionStart: job.startFrame, chunkIndex: chunk.index, processes: config.processes, run,
      ...(base ? { outputBase: base } : {}), ...(storage ? { upload } : {}),
    };
    try {
      const response = await call(fleet, instance.name, '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
      await response.body?.cancel();
      // Refused (the instance is restarting, the platform has none to give): the chunk stays queued. Not an attempt.
      if (!response.ok) return false;
    } catch { return false; }
    chunk.runsStarted = run;
    chunk.runs.push({ instance: instance.name, taskId, startedAt: now, framesRendered: 0, run, progressAt: now, ...(hedge ? { hedge: true } : {}) });
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
  if (config.duplicateStragglers && !job.single) await hedge(job, free, start, config.maxHedgeShare, now);

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
    job.output = { ...file, ...(storage ? { key: objectKey(job.id, `output-r${chunk.run ?? 1}`) } : { instance: chunk.instance! }) };
    return finish(job, fleet, now);
  }
  if (storage) job.stitcher = live(job).find((instance) => answers.has(instance.name))?.name ?? live(job)[0]?.name;
  if (!job.stitcher) {
    if ((job.stitchersLost ?? 0) > MAX_STITCHERS_LOST) return fail(job, `the instance that joins the chunks was lost ${job.stitchersLost} times`, now);
    addInstance(job, now);
    return;
  }
  job.phase = 'stitching';
  // Instances that hold nothing the stitcher still needs are stopped now: an idle instance bills memory until it sleeps.
  for (const instance of live(job)) if (instance.name !== job.stitcher) await retire(job, fleet, instance, now, null);
}

/**
 * Hedging. In the prototype of this design a rule like "duplicate whatever still runs when most chunks are done"
 * started 57 to 159 second runs per one-hour job, and 0 or 1 of them finished first. So a second run is started only
 *   - for a run that is measurably slow: its frames per second since the first frame are under half the median of the
 *     finished chunks, or it has no first frame after three times the median time to the first frame;
 *   - after a grace period, when nothing is queued and another instance has a free slot;
 *   - once per chunk, and for at most `maxHedgeShare` of the chunks (5 %, rounded up).
 * The deadline and the no-progress limit catch what is truly stuck; this only shortens the tail of a slow host.
 */
async function hedge(job: JobState, free: { instance: InstanceState; slots: number }[], start: (chunk: ChunkState, instance: InstanceState, hedge: boolean) => Promise<boolean>, share: number, now: number) {
  if (job.chunks.some((chunk) => chunk.state === 'pending')) return;
  const budget = Math.ceil(job.chunks.length * share);
  const finished = job.chunks.filter((chunk) => chunk.state === 'rendered' || chunk.state === 'stored');
  const typicalFps = median(finished.map((chunk) => chunk.fps ?? NaN));
  if (finished.length < HEDGE_MIN_SAMPLES || !typicalFps) return;
  const typicalFirst = median(finished.map((chunk) => chunk.firstFrameSeconds ?? NaN)) ?? 10;
  const grace = Math.max(HEDGE_GRACE_SECONDS, 2 * typicalFirst);
  for (const chunk of job.chunks) {
    if ((job.hedges ?? 0) >= budget) return;
    const run: ChunkRun | undefined = chunk.runs[0];
    if (chunk.state !== 'running' || chunk.hedged || chunk.runs.length !== 1 || !run) continue;
    const age = (now - run.startedAt) / 1000;
    const sinceFirst = run.firstFrameAt ? (now - run.firstFrameAt) / 1000 : 0;
    const slow = run.firstFrameAt ? age > grace && sinceFirst >= 5 && run.framesRendered / sinceFirst < 0.5 * typicalFps : age > Math.max(grace, 3 * typicalFirst);
    if (!slow) continue;
    const slot = free.find((candidate) => candidate.slots > 0 && candidate.instance.name !== run.instance);
    if (!slot) return;
    if (!(await start(chunk, slot.instance, true))) continue;
    slot.slots -= 1;
    chunk.hedged = true;
    job.hedges = (job.hedges ?? 0) + 1;
    note(job, 'hedge_started', `hedge: second run started for a slow chunk (${run.firstFrameAt ? `${(run.framesRendered / Math.max(1, sinceFirst)).toFixed(1)} fps against a median of ${typicalFps.toFixed(1)}` : `no frame after ${Math.round(age)} s`})`, { chunk: chunk.index, attempt: chunk.runsStarted, instance: slot.instance.name });
  }
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
      if (receipt.sha256 !== file.sha256 || receipt.bytes !== file.bytes) throw Object.assign(new Error(`${file.name} arrived damaged (${receipt.bytes} bytes, hash differs)`), { damaged: true });
    }
    chunk.state = 'stored';
  } catch (error) {
    chunk.transferAttempts += 1;
    note(job, (error as { damaged?: boolean }).damaged ? 'checksum_mismatch' : 'transfer_error', `transfer: ${error instanceof Error ? error.message : String(error)}`, { chunk: chunk.index, instance: chunk.instance });
    if (chunk.transferAttempts >= MAX_TRANSFER_ATTEMPTS) { chunk.state = 'pending'; chunk.transferAttempts = 0; chunk.attempts += 1; chunk.instance = undefined; chunk.files = undefined; }
  }
}

async function stitching(job: JobState, fleet: Fleet, storage: Storage | null, now: number) {
  const stitcher = job.instances.find((instance) => instance.name === job.stitcher && !instance.gone);
  if (!stitcher) { job.phase = 'rendering'; return; }
  const lose = async (message: string) => { job.stitchersLost = (job.stitchersLost ?? 0) + 1; await retire(job, fleet, stitcher, now, { kind: 'stitch_error', message }); };
  if (!job.stitchTask) {
    const attempts = job.stitchAttempts ?? 0;
    if (attempts >= MAX_STITCH_ATTEMPTS) return fail(job, 'stitching failed 3 times', now);
    // Like a chunk run, every attempt to join has its own task id and writes its own output key.
    const suffix = `${attempts}-${job.stitchersLost ?? 0}`;
    const id = `${job.id}-stitch-${suffix}`;
    const outputKey = objectKey(job.id, `output-s${suffix}`);
    const download: Record<string, string> = {};
    const upload: Record<string, string> = {};
    if (storage) {
      for (const chunk of job.chunks) for (const file of chunk.files!) download[file.name] = await storage.presignGet(objectKey(job.id, file.name));
      upload['*'] = await storage.presignPut(outputKey);
    }
    // The stitcher is told which run of every chunk won, with size and hash: it checks each file before it joins it.
    const task: TaskRequest = {
      id, jobId: job.id, kind: 'stitch', render: job.request.render, plan: job.plan!, startFrame: job.startFrame, endFrame: job.endFrame, framesPerChunk: job.framesPerChunk, chunkCount: job.chunks.length,
      chunks: job.chunks.map((chunk) => ({ index: chunk.index, files: chunk.files! })), stitch: settings(job).stitch, ...(storage ? { download, upload } : {}),
    };
    try {
      const response = await call(fleet, stitcher.name, '/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
      await response.body?.cancel();
      if (response.ok) job.stitchTask = { id, startedAt: now, attempts, ...(storage ? { outputKey } : {}) };
      else stitcher.misses += 1;
    } catch { stitcher.misses += 1; }
    if (stitcher.misses > MISSES_BEFORE_REPLACING) await lose('stitch: the instance stopped answering');
    return;
  }
  const answers = await poll(job, fleet, now);
  const tasks = answers.get(stitcher.name);
  if (!tasks) { if (stitcher.misses > MISSES_BEFORE_REPLACING) await lose('stitch: the instance stopped answering'); return; }
  const task = tasks.get(job.stitchTask.id);
  if (!task) { await lose('stitch: task lost, the instance restarted'); return; }
  if (task.state === 'failed') {
    job.stitchAttempts = (job.stitchAttempts ?? 0) + 1;
    note(job, /checksum|damaged|hash/.test(task.error ?? '') ? 'checksum_mismatch' : 'stitch_error', `stitch failed: ${task.error ?? 'unknown error'}`, { instance: stitcher.name, attempt: job.stitchAttempts });
    job.stitchTask = undefined;
    return;
  }
  // Joining copies streams: minutes even for hours of video. The limit grows with the number of chunks to fetch.
  if (task.state === 'running') { if ((now - job.stitchTask.startedAt) / 1000 > Math.max(900, job.chunks.length * 2)) { job.stitchAttempts = (job.stitchAttempts ?? 0) + 1; await lose('stitch: no result in time'); } return; }
  if (storage && !task.uploaded) return;
  job.output = { ...task.files[0]!, ...(job.stitchTask.outputKey ? { key: job.stitchTask.outputKey } : { instance: stitcher.name }) };
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
  if (job.phase !== 'done' && job.phase !== 'failed') { job.phase = 'failed'; job.finishedAt = now; note(job, 'job_cancelled', 'cancelled', { fatal: true }); }
}

export function progressOf(job: JobState, now = Date.now()): RenderProgress {
  const frames = Math.max(1, job.endFrame - job.startFrame);
  const framesRendered = job.chunks.reduce((sum, chunk) => sum + (chunk.state === 'rendered' || chunk.state === 'stored' ? chunk.endFrame - chunk.startFrame : Math.min(chunk.endFrame - chunk.startFrame, Math.max(0, ...chunk.runs.map((run) => run.framesRendered)))), 0);
  const stored = job.chunks.filter((chunk) => chunk.state === 'stored').length;
  const done = job.phase === 'done';
  // Frames are 90 % of the work, bringing the chunks together 5 %, the join 5 %.
  const computed = job.chunks.length === 0 ? 0 : 0.9 * (framesRendered / frames) + 0.05 * (job.single ? framesRendered / frames : stored / job.chunks.length) + (job.phase === 'stitching' ? 0.02 : 0);
  // A chunk that is rendered again takes its frames back, and `framesRendered` shows that. The percentage does not:
  // it keeps its highest value. Only a finished job shows 1.
  const overall = done ? 1 : Math.min(0.999, Math.max(computed, job.progressHigh ?? 0));
  const instanceSeconds = job.instances.reduce((sum, instance) => sum + (instance.gone ? instance.wallSeconds : ((job.finishedAt ?? now) - instance.startedAt) / 1000), 0);
  const cpuSeconds = job.instances.reduce((sum, instance) => sum + instance.cpuSeconds, 0);
  return {
    renderId: job.id, done, overallProgress: Math.round(overall * 1000) / 1000, phase: job.phase, framesRendered, frames,
    chunks: { total: job.chunks.length, rendered: job.chunks.filter((chunk) => chunk.state === 'rendered' || chunk.state === 'stored').length, stored, running: job.chunks.filter((chunk) => chunk.state === 'running').length },
    hedges: { started: job.hedges ?? 0, won: job.hedgesWon ?? 0 },
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
