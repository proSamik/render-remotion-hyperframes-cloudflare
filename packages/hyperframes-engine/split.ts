/**
 * Split rendering of a pure HyperFrames composition: a chunk is a frame range rendered by HyperFrames' own distributed
 * primitives (`@hyperframes/producer/distributed`, the functions behind `hyperframes lambda` and `hyperframes cloudrun`),
 * the join is a byte copy, and the sound is mixed once for the whole timeline.
 *
 *   plan     every instance plans the project itself with `planV2()`: compile, fonts, media probes, the audio mix. The
 *            project is in the image, so every instance plans the same thing; the plan's hash goes into every chunk and
 *            the stitcher refuses chunks planned differently. One plan per instance and job, shared by its processes.
 *   chunk    `renderChunkV2()` with a `frameRange`: fresh seek per frame under HyperFrames' virtual-time shim, software
 *            GL, one closed GOP that starts on an IDR frame. The MP4 it writes is rewrapped (no re-encode) as MPEG-TS with
 *            timestamps at the chunk's place on the timeline, so chunks of any length join byte after byte.
 *   stitch   the chunks' MPEG-TS in order into one FFmpeg that copies the video and puts the plan's single audio track
 *            under it. The frame count is checked at the end, the SHA-256 of every chunk while it streams by.
 *
 * Why not HyperFrames' own `assembleV2()`: it expects HyperFrames' chunk grid (one output per slice of its plan). The
 * coordinator of this repository plans its own chunks, retries and hedges them, and joins them on whichever instance
 * holds them. The join here does what assemble does for H.264 MP4 (copy the video, mux the plan's audio) on that grid.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { outputSize } from '../core/src/resolution.ts';
import { downloadVerified, hashFile, putFile } from '../core/src/transfer.ts';
import type { ChunkFeed, SharedPlanUrls, StreamOutput, TaskRequest } from '../core/src/types.ts';
import { audioPlan, checkChunks, distributedQuality, partsOf, SLICE_FRAMES, tsOffsetSeconds, type ChunkMeta, type Slice } from './ranges.ts';

/** The part of `@hyperframes/producer/distributed` used here (its own types are richer; this keeps the root type check independent of the example's node_modules). */
type Distributed = {
  planV2(projectDir: string, config: Record<string, unknown>, planDir: string): Promise<{ planHash: string; sourcePlanV1Hash: string; chunkCount: number; totalFrames: number; fps: number; width: number; height: number; producerVersion: string }>;
  renderChunkV2(planDir: string, chunkIndex: number, outputPath: string, options?: { frameRange?: { startFrame: number; endFrame: number } }): Promise<{ framesEncoded: number; sha256: string; workers: number; captureMode?: string; durationMs: number }>;
  materializePlanV2Target(planDir: string, target: { role: 'assembler' } | { role: 'chunk'; chunkIndex: number }, destination: string): { planDir: string; audioPath: string | null; sourcePlanV1Hash: string };
};

export type SplitOptions = {
  quality?: string;
  fps?: number;
  /** Values for the composition's `data-composition-variables`. */
  variables?: Record<string, unknown>;
  /** Output size: a name from packages/core/src/resolution.ts ("480p", "4k") or "composition" (default). */
  resolution?: string;
  /** Longest gap between keyframes inside a chunk, in seconds. Default 2. Every chunk also starts with one. */
  keyframeIntervalSeconds?: number;
  /** x264 CRF instead of the quality's own (lower is better; HyperFrames refuses it together with a bitrate). */
  crf?: number;
  /** Capture browsers per chunk process. Default: the instance's CPUs shared by its processes; 'auto' lets HyperFrames size it. */
  workers?: number | 'auto';
};

// No telemetry from a render service. No Chrome sandbox on Linux: containers have no user namespaces for it (the
// CLI path of engine.ts does the same).
const ENV: Record<string, string> = { HYPERFRAMES_TELEMETRY: '0', DO_NOT_TRACK: '1', ...(process.platform === 'linux' && !process.env.HYPERFRAMES_CHROME_SANDBOX ? { HYPERFRAMES_CHROME_SANDBOX: '0' } : {}) };

/** Finds `@hyperframes/producer` in the node_modules above `from` (the package exports only ESM entry points, so require.resolve cannot). */
export async function loadDistributed(from: string): Promise<Distributed> {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', '@hyperframes', 'producer', 'package.json');
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, 'utf8')).exports?.['./distributed'];
      const file = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
      if (!file) throw new Error(`${manifest} has no ./distributed export: use @hyperframes/producer 0.9.103 or newer`);
      return (await import(pathToFileURL(join(dirname(manifest), file)).href)) as Distributed;
    }
    if (dirname(dir) === dir) throw new Error(`@hyperframes/producer is not installed above ${from}: add it next to the pinned hyperframes CLI (same version)`);
  }
}

/**
 * HyperFrames' distributed renderer does not download a browser; the CLI does (`hyperframes browser ensure`, a fraction
 * of a second when the browser is there). Skipped when the image names one (HYPERFRAMES_BROWSER_PATH or
 * PRODUCER_HEADLESS_SHELL_PATH, as the example Dockerfile does).
 */
export async function ensureBrowser(cli: string): Promise<void> {
  if (process.env.HYPERFRAMES_BROWSER_PATH || process.env.PRODUCER_HEADLESS_SHELL_PATH) return;
  await run(process.execPath, [cli, 'browser', 'ensure']);
}

/** Output size and how it is reached: HyperFrames supersamples up to a preset; below the composition the chunk is scaled once. */
export function sizeFor(width: number, height: number, resolution: string | undefined): { width: number; height: number; outputResolution?: string; downscale: boolean; bitrate: number } {
  const size = outputSize(width, height, resolution ?? 'composition');
  if (size.width === width && size.height === height) return { width, height, downscale: false, bitrate: size.bitrate };
  if (size.width < width) return { width: size.width, height: size.height, downscale: true, bitrate: size.bitrate };
  const orientation = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  const preset = { 1080: orientation, 1440: `${orientation}-1440p`, 2160: `${orientation}-4k` }[Math.min(size.width, size.height)];
  if (!preset) throw new Error(`HyperFrames renders larger than the composition only to 1080p, 1440p or 2160p (asked: ${resolution})`);
  return { width: size.width, height: size.height, outputResolution: preset, downscale: false, bitrate: size.bitrate };
}

/** HyperFrames' render configuration for a job. Every instance must build the same one: it goes into the plan's hash. */
export function planConfig(base: { fps: number; width: number; height: number }, options: SplitOptions): Record<string, unknown> {
  const size = sizeFor(base.width, base.height, options.resolution);
  return {
    fps: base.fps, width: base.width, height: base.height, format: 'mp4', codec: 'h264',
    ...distributedQuality(options.quality),
    ...(options.crf !== undefined ? { crf: options.crf } : {}),
    keyframeIntervalSeconds: options.keyframeIntervalSeconds ?? 2,
    // Few long slices: a chunk of the coordinator is then one renderChunkV2() call, rarely two.
    chunkSize: SLICE_FRAMES, maxParallelChunks: 256,
    ...(size.outputResolution ? { outputResolution: size.outputResolution } : {}),
    ...(options.variables ? { variables: options.variables } : {}),
  };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export type LocalPlan = {
  planDir: string; planHash: string; totalFrames: number; slices: Slice[]; audioPath: string | null;
  /** How this instance got it, and how long that took: planned here, or fetched from the shared copy. */
  source?: 'local' | 'shared'; seconds?: number;
};

/** The receipt of a shared plan: written after the archive, so a receipt means the archive is complete. */
type SharedReceipt = { key: string; planHash: string; bytes: number; sha256: string; planSeconds: number };

const SHARED_WAIT_MS = Number(process.env.HF_SHARED_PLAN_WAIT_MS ?? 60_000);

/** Fetches the shared plan into `jobDir` and answers true, or false when there is none (yet) or it is not ours. */
async function fetchSharedPlan(shared: SharedPlanUrls, jobDir: string, key: string): Promise<boolean> {
  const until = Date.now() + SHARED_WAIT_MS;
  let receipt: SharedReceipt | null = null;
  while (!receipt && Date.now() < until) {
    const response = await fetch(shared.receiptGet).catch(() => null);
    if (response?.ok) receipt = (await response.json().catch(() => null)) as SharedReceipt | null;
    else { await response?.body?.cancel(); await sleep(1000); }
  }
  // A plan for another project or configuration is never used: the key is the hash of both.
  if (!receipt || receipt.key !== key) return false;
  const archive = join(jobDir, `shared-plan-${process.pid}.tar`);
  try {
    await downloadVerified(shared.archiveGet, archive, { bytes: receipt.bytes, sha256: receipt.sha256 });
    await run('tar', ['-xf', archive, '-C', jobDir]);
    const described = JSON.parse(await readFile(join(jobDir, `hf-plan-${key}.json`), 'utf8')) as LocalPlan;
    return described.planHash === receipt.planHash;
  } catch { return false; }
  finally { await rm(archive, { force: true }); }
}

/** Packs the plan (plan, assembler files, description) and uploads it, then the receipt. Failures only cost the sharing. */
async function publishSharedPlan(shared: SharedPlanUrls, jobDir: string, key: string, plan: LocalPlan): Promise<void> {
  const archive = join(jobDir, `shared-plan-${process.pid}.tar`);
  try {
    await run('tar', ['-cf', archive, '-C', jobDir, `hf-plan-${key}`, `hf-plan-${key}-assembler`, `hf-plan-${key}.json`]);
    const file = await hashFile(archive, 'shared-plan.tar');
    await putFile(shared.archivePut, archive, file);
    const receipt: SharedReceipt = { key, planHash: plan.planHash, bytes: file.bytes, sha256: file.sha256, planSeconds: plan.seconds ?? 0 };
    const body = JSON.stringify(receipt);
    const response = await fetch(shared.receiptPut, { method: 'PUT', body, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
    await response.body?.cancel();
  } catch (error) { console.error(`shared plan not published: ${error instanceof Error ? error.message : error}`); }
  finally { await rm(archive, { force: true }); }
}

/**
 * The job's plan on this instance: made once, by whichever process asks first; the others wait for it. It lives in the
 * job's folder, so it goes when the job's files are deleted, and an edited project is planned again by the next job.
 */
export async function ensurePlan(api: Distributed, input: { jobDir: string; projectDir: string; config: Record<string, unknown>; prepare?: () => Promise<void>; shared?: SharedPlanUrls }): Promise<LocalPlan> {
  const key = sha256(JSON.stringify({ projectDir: input.projectDir, config: input.config })).slice(0, 16);
  const planDir = join(input.jobDir, `hf-plan-${key}`);
  const assemblerDir = `${planDir}-assembler`;
  const lock = `${planDir}.lock`;
  const ready = `${planDir}.json`;
  await mkdir(input.jobDir, { recursive: true });
  for (let waited = 0; !existsSync(ready); waited += 1) {
    try {
      await mkdir(lock);
    } catch {
      // Another process plans. Wait, unless it died: then take the lock over.
      const holder = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
      if (holder && !alive(holder)) await rm(lock, { recursive: true, force: true });
      else if (waited > 1200) throw new Error('waited 10 minutes for another process to plan the composition');
      await sleep(500);
      continue;
    }
    try {
      await writeFile(join(lock, 'pid'), String(process.pid));
      if (existsSync(ready)) break;
      const began = Date.now();
      // Shared through storage: fetched when another instance made it, so this one does not plan the same thing again.
      if (input.shared?.role === 'fetch' && (await fetchSharedPlan(input.shared, input.jobDir, key))) {
        const fetched = JSON.parse(await readFile(ready, 'utf8')) as LocalPlan;
        await writeFile(ready, JSON.stringify({ ...fetched, source: 'shared', seconds: (Date.now() - began) / 1000 }));
        break;
      }
      await input.prepare?.();
      const staging = `${planDir}.${process.pid}`;
      await rm(staging, { recursive: true, force: true });
      const result = await api.planV2(input.projectDir, input.config, staging);
      await rm(planDir, { recursive: true, force: true });
      await rename(staging, planDir);
      // The assembler's files (chunk list and the mixed audio) are materialized once, next to the plan.
      await rm(assemblerDir, { recursive: true, force: true });
      const assembler = api.materializePlanV2Target(planDir, { role: 'assembler' }, assemblerDir);
      const slices = JSON.parse(await readFile(join(assembler.planDir, 'meta', 'chunks.json'), 'utf8')) as Slice[];
      const description: LocalPlan = { planDir, planHash: result.sourcePlanV1Hash, totalFrames: result.totalFrames, slices: slices.map(({ index, startFrame, endFrame }) => ({ index, startFrame, endFrame })), audioPath: assembler.audioPath, source: 'local', seconds: (Date.now() - began) / 1000 };
      await writeFile(`${ready}.tmp`, JSON.stringify(description));
      await rename(`${ready}.tmp`, ready);
      if (input.shared?.role === 'make') await publishSharedPlan(input.shared, input.jobDir, key, description);
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return JSON.parse(await readFile(ready, 'utf8')) as LocalPlan;
}

/** Runs a program, keeps the tail of what it says, rejects on a non-zero exit. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((done, failed) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { err = (err + data).slice(-3000); });
    child.once('error', failed);
    child.once('close', (code) => (code === 0 ? done(out) : failed(new Error(`${command} ${args.slice(0, 3).join(' ')} ... ended with code ${code}: ${err.slice(-1200)}`))));
  });
}

/** Video packets (= frames), size and duration of the first video stream. */
export async function probeVideo(file: string): Promise<{ frames: number; width: number; height: number; seconds: number }> {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height,duration:format=duration', '-of', 'json', file]));
  const stream = json.streams?.[0] ?? {};
  return { frames: Number(stream.nb_read_packets), width: Number(stream.width), height: Number(stream.height), seconds: Number(stream.duration ?? json.format?.duration) };
}

/** Counts the frames HyperFrames has captured so far for a part: files in its work folders. Progress only. */
function capturedFrames(partPath: string): number {
  const dir = dirname(partPath);
  const prefix = `${partPath.slice(dir.length + 1)}.work.`;
  let count = 0;
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { if (entry.isDirectory()) walk(join(path, entry.name)); else if (/\.(png|jpe?g|webp|raw|bmp)$/i.test(entry.name)) count += 1; } };
  try { for (const name of readdirSync(dir)) if (name.startsWith(prefix) && statSync(join(dir, name)).isDirectory()) walk(join(dir, name)); } catch { /* folders come and go */ }
  return count;
}

/** Capture browsers per process: the instance's CPUs shared by the processes that run beside each other. */
function applyWorkers(options: SplitOptions, processes: number | undefined) {
  Object.assign(process.env, ENV);
  if (options.workers === 'auto') return;
  // Also with one process per instance: left to itself the distributed renderer captured with one browser, and a
  // heavy chunk on a 4 vCPU instance used about 1 vCPU (measured on Cloudflare, 2026-11-28).
  const workers = typeof options.workers === 'number' ? options.workers : Math.max(1, Math.floor(cpus().length / (processes ?? 1)));
  if (workers) process.env.PRODUCER_MAX_WORKERS = String(workers);
}

/** Renders the task's frames into `<outputBase>.ts` and `<outputBase>.json` in `dir`. */
export async function renderSplitChunk(input: { api: Distributed; prepare?: () => Promise<void>; task: TaskRequest; dir: string; projectDir: string; composition: { fps: number; width: number; height: number }; options: SplitOptions; onProgress: (frames: number) => void }): Promise<string[]> {
  const { api, task, dir, options } = input;
  const started = Date.now();
  applyWorkers(options, task.processes);
  const config = planConfig(input.composition, options);
  const plan = await ensurePlan(api, { jobDir: dir, projectDir: input.projectDir, config, ...(input.prepare ? { prepare: input.prepare } : {}), ...(task.sharedPlan ? { shared: task.sharedPlan } : {}) });
  const startFrame = task.startFrame ?? 0;
  const endFrame = task.endFrame ?? plan.totalFrames;
  const parts = partsOf(plan.slices, startFrame, endFrame);
  const size = sizeFor(input.composition.width, input.composition.height, options.resolution);
  const fps = input.composition.fps;
  const gop = Math.max(1, Math.round((options.keyframeIntervalSeconds ?? 2) * fps));
  const base = task.outputBase ?? 'single';
  const video = `${base}.ts`;
  const videoPath = join(dir, video);
  await rm(videoPath, { force: true });
  let done = 0;
  for (const [index, part] of parts.entries()) {
    const partPath = join(dir, `${base}.part${index}.mp4`);
    const tick = setInterval(() => input.onProgress(done + Math.min(part.endFrame - part.startFrame, capturedFrames(partPath))), 1000);
    try {
      const result = await api.renderChunkV2(plan.planDir, part.slice, partPath, { frameRange: { startFrame: part.startFrame, endFrame: part.endFrame } });
      if (result.framesEncoded !== part.endFrame - part.startFrame) throw new Error(`HyperFrames encoded ${result.framesEncoded} frames for frames ${part.startFrame}-${part.endFrame}`);
    } finally { clearInterval(tick); }
    // Rewrapped, not re-encoded: the H.264 stream as it is, in MPEG-TS, at its place on the timeline. Below the
    // composition's size the part is scaled and encoded once here instead, with the same GOP rule.
    const tsPath = join(dir, `${base}.part${index}.ts`);
    const offset = ['-output_ts_offset', String(tsOffsetSeconds(part.startFrame, fps))];
    const codec = size.downscale
      ? ['-vf', `scale=${size.width}:${size.height}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-pix_fmt', 'yuv420p', '-b:v', String(size.bitrate), '-maxrate', String(size.bitrate), '-bufsize', String(2 * size.bitrate), '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-flags', '+cgop', '-force_key_frames', 'expr:eq(n,0)']
      : ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb'];
    await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', partPath, '-map', '0:v:0', ...codec, ...offset, '-f', 'mpegts', tsPath]);
    const probed = await probeVideo(tsPath);
    if (probed.frames !== part.endFrame - part.startFrame) throw new Error(`part ${index} has ${probed.frames} frames, expected ${part.endFrame - part.startFrame}`);
    if (probed.width !== size.width || probed.height !== size.height) throw new Error(`part ${index} is ${probed.width}x${probed.height}, expected ${size.width}x${size.height}`);
    await pipeline(createReadStream(tsPath), createWriteStream(videoPath, { flags: 'a' }));
    await rm(partPath, { force: true });
    await rm(`${partPath}.perf.json`, { force: true });
    await rm(tsPath, { force: true });
    done += part.endFrame - part.startFrame;
    input.onProgress(done);
  }
  const hash = createHash('sha256');
  for await (const data of createReadStream(videoPath)) hash.update(data as Buffer);
  const meta: ChunkMeta = {
    version: 1, planHash: plan.planHash, fps, width: size.width, height: size.height, startFrame, endFrame, frames: done, parts, gop,
    video: { name: video, bytes: (await stat(videoPath)).size, sha256: hash.digest('hex') }, renderSeconds: (Date.now() - started) / 1000,
    ...(plan.source ? { plan: { source: plan.source, seconds: plan.seconds ?? 0 } } : {}),
  };
  await writeFile(join(dir, `${base}.json`), JSON.stringify(meta, null, 2));
  return [video, `${base}.json`];
}

/** The muxer's own frame counter, from its log. */
const lastFrame = (text: string) => { const match = [...text.matchAll(/frame=\s*(\d+)/g)].pop(); return match ? Number(match[1]) : null; };
const write = (stream: Writable, data: Uint8Array) => new Promise<void>((done, failed) => { stream.write(data, (error) => (error ? failed(error) : done())); });

/**
 * Joins the chunks of `task` into `out.mp4` (or a fragmented MP4 into `output`). With a `feed` (streaming join) every
 * chunk is awaited before it is read and deleted after; without one every chunk is already in `dir`.
 */
export async function stitchSplit(input: { api: Distributed; prepare?: () => Promise<void>; task: TaskRequest; dir: string; projectDir: string; composition: { fps: number; width: number; height: number }; options: SplitOptions; feed?: ChunkFeed; output?: StreamOutput }): Promise<string[]> {
  const { api, task, dir, options, feed } = input;
  Object.assign(process.env, ENV);
  const config = planConfig(input.composition, options);
  const plan = await ensurePlan(api, { jobDir: dir, projectDir: input.projectDir, config, ...(input.prepare ? { prepare: input.prepare } : {}), ...(task.sharedPlan ? { shared: task.sharedPlan } : {}) });
  const size = sizeFor(input.composition.width, input.composition.height, options.resolution);
  const fps = input.composition.fps;
  const chunks = [...(task.chunks ?? [])].sort((a, b) => a.index - b.index);
  const startFrame = task.startFrame ?? 0;
  const endFrame = task.endFrame ?? plan.totalFrames;
  const frames = endFrame - startFrame;
  if (endFrame > plan.totalFrames) throw new Error(`the job ends at frame ${endFrame}, HyperFrames' plan at ${plan.totalFrames}: the composition's data-duration and its timeline disagree`);

  // Each chunk's description travels with it (second file). Read them all first when they are here; in a streaming
  // join each one is checked when its chunk arrives, against the job and the chunk before it.
  const metaOf = async (index: number) => JSON.parse(await readFile(join(dir, chunks[index]!.files[1]!.name), 'utf8')) as ChunkMeta;
  const expected = { startFrame, endFrame, planHash: plan.planHash, fps, width: size.width, height: size.height };
  if (!feed) { const problems = checkChunks(await Promise.all(chunks.map((_, index) => metaOf(index))), expected); if (problems.length) throw new Error(`the chunks cannot be joined: ${problems.join('; ')}`); }

  const sound = audioPlan({ hasAudio: Boolean(plan.audioPath && existsSync(plan.audioPath)), startFrame, endFrame, fps });
  const streamed = Boolean(input.output) && task.stitch === 'stream-fmp4';
  const fragmented = task.stitch === 'stream-fmp4';
  const outputName = 'out.mp4';
  const outputPath = join(dir, outputName);
  // A copy is cut with -t only: an input -ss, even -ss 0, makes FFmpeg drop the AAC priming information and the first
  // 9 ms come out silent (measured). A range is decoded from its start and encoded again, which cuts on the sample.
  const audioArgs = sound.mode === 'none' ? [] : [...(sound.mode === 'cut' ? ['-ss', String(sound.startSeconds)] : []), '-t', String(sound.seconds), '-i', plan.audioPath!];
  const muxer: ChildProcess = spawn('ffmpeg', [
    '-hide_banner', '-nostdin', '-f', 'mpegts', '-i', 'pipe:3', ...audioArgs,
    '-map', '0:v:0', ...(sound.mode === 'none' ? [] : ['-map', '1:a:0']), '-c:v', 'copy', ...(sound.mode === 'copy' ? ['-c:a', 'copy'] : sound.mode === 'cut' ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-r', String(fps),
    ...(fragmented ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-min_frag_duration', '4000000'] : ['-movflags', '+faststart']),
    '-metadata', 'comment=Joined from HyperFrames chunks (render-remotion-hyperframes-cloudflare)',
    ...(streamed ? ['-f', 'mp4', 'pipe:1'] : ['-f', 'mp4', '-y', outputPath]),
  ], { stdio: ['ignore', streamed ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let log = '';
  muxer.stderr!.on('data', (data: Buffer) => { log = (log + data.toString('utf8')).slice(-4000); });
  const videoIn = muxer.stdio[3] as Writable;
  videoIn.on('error', () => undefined);
  const ended = new Promise<number | null>((done) => { muxer.once('close', done); muxer.once('error', () => done(-1)); });
  const leaving = streamed ? input.output!.write(muxer.stdout as Readable) : null;
  const metas: ChunkMeta[] = [];
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      if (feed) await feed.ready(index);
      const meta = await metaOf(index);
      metas.push(meta);
      if (feed) { const problems = checkChunks(metas, { ...expected, endFrame: meta.endFrame }); if (problems.length) throw new Error(`the chunks cannot be joined: ${problems.join('; ')}`); }
      const hash = createHash('sha256');
      for await (const data of createReadStream(join(dir, chunks[index]!.files[0]!.name), { highWaterMark: 1 << 20 })) { hash.update(data as Buffer); await write(videoIn, data as Buffer); }
      if (hash.digest('hex') !== meta.video.sha256) throw new Error(`chunk ${index}: the video's hash differs from the one written where it was rendered (damaged)`);
      if (feed) await feed.release(index);
    }
    videoIn.end();
    const code = await ended;
    await leaving;
    if (code !== 0) throw new Error(`ffmpeg ended with code ${code}: ${log.slice(-1200)}`);
  } catch (error) {
    muxer.kill('SIGKILL');
    if (!streamed) await rm(outputPath, { force: true });
    // A closed pipe means FFmpeg went away: its log is the error worth reporting.
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') throw new Error(`ffmpeg ended early: ${log.slice(-1200)}`);
    throw error;
  }
  const muxed = lastFrame(log);
  if (muxed !== null && muxed !== frames) throw new Error(`the joined video has ${muxed} frames, expected ${frames}`);
  if (!streamed) {
    // Counted again from the file: frames, and a duration that is the frame count at the frame rate (half a frame of slack).
    const probed = await probeVideo(outputPath);
    if (probed.frames !== frames) throw new Error(`the joined file has ${probed.frames} frames, expected ${frames}`);
    if (Math.abs(probed.seconds - frames / fps) > 0.5 / fps + 1e-6) throw new Error(`the joined video lasts ${probed.seconds} s, expected ${frames / fps} s`);
  }
  return [outputName];
}

/** One process renders the whole range and joins it alone: `--chunks 1`, or a job too short to split. */
export async function renderSplitSingle(input: { api: Distributed; prepare?: () => Promise<void>; task: TaskRequest; dir: string; projectDir: string; composition: { fps: number; width: number; height: number }; options: SplitOptions; onProgress: (frames: number) => void }): Promise<string[]> {
  const task: TaskRequest = { ...input.task, outputBase: `${input.task.id}-whole` };
  const [video, meta] = await renderSplitChunk({ ...input, task });
  const stitch: TaskRequest = { ...task, kind: 'stitch', chunks: [{ index: 0, files: [{ name: video!, bytes: 0, sha256: '' }, { name: meta!, bytes: 0, sha256: '' }] }], stitch: 'combine' };
  const [out] = await stitchSplit({ ...input, task: stitch });
  for (const name of [video!, meta!]) await rm(join(input.dir, name), { force: true });
  return [out!];
}
