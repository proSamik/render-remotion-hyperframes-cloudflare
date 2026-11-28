/**
 * From "how soon" to a chunk length and a fleet. Pure functions; the rates are data you measure.
 *
 * A tier is a finish-time target and bounds for the chunk length. It is never an instance count: the fleet follows
 * from the content, and only then is it bounded by what the caller may spend (`maxInstances`).
 *
 *   target     a share of the video's length, with a floor (a 20 s clip cannot be "6 % of its length" fast);
 *   chunks     equal for the whole job (Remotion's join needs that), whole seconds;
 *              long enough that start-up (browser start, composition load) is a small share of a chunk's time,
 *              short enough that the slowest kind of chunk still fits the target;
 *   fleet      per cost class, enough render processes to finish its chunks inside the target, never more processes
 *              than chunks. A class that fills an instance alone gets one instance per process.
 *
 * Cost classes describe what a frame costs to render, not what it shows:
 *   light   no WebGL: CPU raster, several processes share an instance;
 *   gl      WebGL that is cheap in software: shares an instance too, needs the GL backend;
 *   heavy   WebGL that fills an instance on its own (a heavy shader, a 3D model): one chunk, one instance.
 * A chunk has the heaviest class of anything visible in its frame range.
 *
 * The result maps onto the coordinator's `fleet` options with toFleetOptions(). The coordinator of this repository
 * runs every chunk with the same number of processes per instance; class-aware placement is described in
 * docs/planning.md, not built here.
 */
import type { FleetOptions } from './types.ts';

export type Tier = { /** target = max(floorSeconds, share x duration) */ share: number; floorSeconds: number; minChunkSeconds: number; maxChunkSeconds: number };
export const TIERS = {
  saver: { share: 0.25, floorSeconds: 300, minChunkSeconds: 20, maxChunkSeconds: 60 },
  economy: { share: 0.12, floorSeconds: 180, minChunkSeconds: 10, maxChunkSeconds: 30 },
  standard: { share: 0.06, floorSeconds: 120, minChunkSeconds: 6, maxChunkSeconds: 10 },
  fast: { share: 0.04, floorSeconds: 90, minChunkSeconds: 4, maxChunkSeconds: 4 },
} satisfies Record<string, Tier>;
export type TierName = keyof typeof TIERS;

export const COST_CLASSES = ['light', 'gl', 'heavy'] as const;
export type CostClass = (typeof COST_CLASSES)[number];
/** Per class: frames per second of ONE process when the instance is filled as `perInstance` says, and seconds to the first frame. */
export type ClassRate = { fps: number; firstFrameSeconds: number; perInstance: number };
export type Rates = Record<CostClass, ClassRate>;

/**
 * Example rates, 1080p30 on Cloudflare standard-4 (4 vCPU, no GPU), from one one-hour project in the prototype of this
 * design: light 5.8 fps per process with 5.1 s to the first frame, heavy (glow and blur shaders on llvmpipe) 1.46 fps
 * per instance (median) with 9.8 s. `gl` is a single data point (3.9 fps for a cheap effect). Measure your own content:
 * render a few seconds of each kind and read the fps from the progress.
 */
export const EXAMPLE_RATES: Rates = {
  light: { fps: 5.8, firstFrameSeconds: 5.1, perInstance: 2 },
  gl: { fps: 3.9, firstFrameSeconds: 7, perInstance: 2 },
  heavy: { fps: 1.46, firstFrameSeconds: 9.8, perInstance: 1 },
};

export type Segment = { startFrame: number; /** exclusive */ endFrame: number; cls: CostClass };
/** The heaviest class visible in [startFrame, endFrame). No segment: light. */
export function classOfRange(segments: Segment[] | undefined, startFrame: number, endFrame: number): CostClass {
  let heaviest = 0;
  for (const segment of segments ?? []) if (segment.startFrame < endFrame && segment.endFrame > startFrame) heaviest = Math.max(heaviest, COST_CLASSES.indexOf(segment.cls));
  return COST_CLASSES[heaviest]!;
}

/** One chunk of a job: frames `[startFrame, endFrame)` and the heaviest class visible in them. */
export type ChunkRange = { startFrame: number; endFrame: number; cls: CostClass };
export type RangeOptions = {
  /** The job's frames, end exclusive. */
  startFrame: number;
  endFrame: number;
  fps: number;
  segments?: Segment[];
  /** About how many chunks: one per render process of the fleet. */
  targetChunks: number;
  /** Bounds in seconds of video. A chunk shorter than `min` wastes its start-up; one longer than `max` makes a retry expensive. */
  minSeconds?: number;
  maxSeconds?: number;
  /** Variable chunks only: no chunk holds more than this many seconds of heavy frames (a cap on top of the cost rule). */
  heavyMaxSeconds?: number;
  /** Variable chunks only: what a frame of each class costs against a light one. Default: from EXAMPLE_RATES (gl 1.5, heavy 4). */
  weights?: Partial<Record<CostClass, number>>;
  /**
   * false (Remotion): every chunk has the same length except the last; segments are ignored, because the join needs a
   * fixed grid. true (HyperFrames): chunks of equal COST, so a heavy range gets shorter chunks.
   */
  variable?: boolean;
};

/** Cost of a frame of each class against a light one: the inverse of the example rates (light 1, gl 1.5, heavy 4). */
export const CLASS_WEIGHTS: Record<CostClass, number> = {
  light: 1,
  gl: Math.round((EXAMPLE_RATES.light.fps / EXAMPLE_RATES.gl.fps) * 10) / 10,
  heavy: Math.round(EXAMPLE_RATES.light.fps / EXAMPLE_RATES.heavy.fps),
};

/**
 * Cuts a job into chunks. Pure function.
 *
 *   fixed grid (variable false, Remotion)  length = frames / targetChunks inside [min, max]; equal chunks, the last one
 *                                           shorter.
 *   equal cost (variable true, HyperFrames) every frame costs its class's weight (light 1, heavy 4 by default); the job
 *                                           is cut into targetChunks chunks of equal cost, so four processes finish
 *                                           together even when one scene is four times slower. The number of chunks
 *                                           is bounded so that an average chunk stays inside [min, max]; no chunk is
 *                                           shorter than `min` unless the job is; `heavyMax` caps the heavy frames of
 *                                           one chunk (a long chunk over a heavy range is split in equal parts).
 */
export function planRanges(options: RangeOptions): ChunkRange[] {
  const { startFrame, endFrame, fps } = options;
  const frames = Math.max(0, Math.floor(endFrame) - Math.floor(startFrame));
  if (frames === 0) return [];
  const min = Math.max(1, Math.round((options.minSeconds ?? 2) * fps));
  const max = Math.max(min, Math.round((options.maxSeconds ?? 30) * fps));
  const at = (from: number, to: number): ChunkRange => ({ startFrame: from, endFrame: to, cls: classOfRange(options.segments, from, to) });
  if (!options.variable) {
    const length = Math.min(max, Math.max(min, Math.ceil(frames / Math.max(1, Math.floor(options.targetChunks)))));
    const ranges: ChunkRange[] = [];
    for (let from = startFrame; from < endFrame; from += length) ranges.push(at(from, Math.min(endFrame, from + length)));
    return ranges;
  }
  // Cost of every frame: the heaviest class visible on it.
  const weights = { ...CLASS_WEIGHTS, ...options.weights };
  const cost = new Float64Array(frames).fill(weights.light);
  for (const segment of options.segments ?? []) {
    const weight = weights[segment.cls];
    for (let frame = Math.max(startFrame, segment.startFrame); frame < Math.min(endFrame, segment.endFrame); frame += 1) cost[frame - startFrame] = Math.max(cost[frame - startFrame]!, weight);
  }
  const total = cost.reduce((sum, value) => sum + value, 0);
  const count = Math.max(1, Math.min(Math.max(1, Math.floor(frames / min)), Math.max(Math.ceil(frames / max), Math.round(options.targetChunks))));
  // Cut where the running cost passes k/count of the total, at the nearer frame; never closer than `min` frames.
  const cuts: number[] = [];
  let running = 0;
  let last = 0;
  for (let index = 0; index < frames && cuts.length < count - 1; index += 1) {
    const before = running;
    running += cost[index]!;
    const target = (total * (cuts.length + 1)) / count;
    if (running < target) continue;
    const cut = target - before < running - target ? index : index + 1;
    if (cut - last >= min && frames - cut >= min) { cuts.push(cut); last = cut; }
  }
  const bounds = [0, ...cuts, frames];
  let ranges: ChunkRange[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) ranges.push(at(startFrame + bounds[index]!, startFrame + bounds[index + 1]!));
  // The cap on heavy frames per chunk.
  if (options.heavyMaxSeconds !== undefined) {
    const heavyMax = Math.max(1, Math.round(options.heavyMaxSeconds * fps));
    ranges = ranges.flatMap((range) => {
      let heavy = 0;
      for (let frame = range.startFrame; frame < range.endFrame; frame += 1) if (cost[frame - startFrame]! >= weights.heavy) heavy += 1;
      const parts = Math.ceil(heavy / heavyMax);
      if (parts <= 1) return [range];
      const size = range.endFrame - range.startFrame;
      return Array.from({ length: parts }, (_, part) => at(range.startFrame + Math.round((part * size) / parts), range.startFrame + Math.round(((part + 1) * size) / parts)));
    });
  }
  return ranges;
}

export type FleetPlan = {
  targetSeconds: number;
  framesPerChunk: number;
  chunkSeconds: number;
  chunks: Record<CostClass, number>;
  /** What the content asks for, and what `maxInstances` leaves of it. */
  wantedInstances: number;
  instances: number;
  bounded: boolean;
  /** Start-up as a share of a light chunk's time: the price of short chunks. */
  startupShare: number;
};

export function planFleet(info: { fps: number; frames: number; segments?: Segment[] }, tier: Tier = TIERS.standard, rates: Rates = EXAMPLE_RATES, bounds: { maxInstances?: number } = {}): FleetPlan {
  const perSecond = Math.max(1, Math.round(info.fps));
  const frames = Math.max(1, Math.floor(info.frames));
  const targetSeconds = Math.max(tier.floorSeconds, (frames / info.fps) * tier.share);
  const hasHeavy = (info.segments ?? []).some((segment) => segment.cls === 'heavy' && segment.startFrame < frames && segment.endFrame > 0);
  // Start-up at most 15 % of a light chunk's time ...
  const lightMinimum = Math.ceil((rates.light.fps * rates.light.firstFrameSeconds) / 0.15 / perSecond) * perSecond;
  // ... and one heavy chunk must still fit the target. When the two disagree the heavy bound wins.
  const heavyMaximum = Math.max(3 * perSecond, Math.floor(((targetSeconds - rates.heavy.firstFrameSeconds) * rates.heavy.fps) / perSecond) * perSecond);
  let framesPerChunk = hasHeavy ? Math.min(lightMinimum, heavyMaximum) : lightMinimum;
  framesPerChunk = Math.min(tier.maxChunkSeconds * perSecond, Math.max(tier.minChunkSeconds * perSecond, framesPerChunk));
  framesPerChunk = Math.max(perSecond, Math.min(framesPerChunk, Math.ceil(frames / perSecond) * perSecond));

  const chunks: Record<CostClass, number> = { light: 0, gl: 0, heavy: 0 };
  const classFrames: Record<CostClass, number> = { light: 0, gl: 0, heavy: 0 };
  for (let start = 0; start < frames; start += framesPerChunk) {
    const end = Math.min(frames, start + framesPerChunk);
    const cls = classOfRange(info.segments, start, end);
    chunks[cls] += 1;
    classFrames[cls] += end - start;
  }
  let wantedInstances = 0;
  for (const cls of COST_CLASSES) {
    if (!chunks[cls]) continue;
    const rate = rates[cls];
    // Seconds of one process for all chunks of the class, start-up included, spread over the target.
    const work = classFrames[cls] / rate.fps + chunks[cls] * rate.firstFrameSeconds;
    const processes = Math.min(chunks[cls], Math.max(1, Math.ceil(work / targetSeconds)));
    wantedInstances += Math.ceil(processes / Math.max(1, rate.perInstance));
  }
  const instances = Math.max(1, Math.min(bounds.maxInstances ?? Infinity, wantedInstances));
  const lightChunkSeconds = framesPerChunk / rates.light.fps + rates.light.firstFrameSeconds;
  return { targetSeconds, framesPerChunk, chunkSeconds: framesPerChunk / perSecond, chunks, wantedInstances, instances, bounded: instances < wantedInstances, startupShare: rates.light.firstFrameSeconds / lightChunkSeconds };
}

/** The plan as options for the coordinator of this repository. */
export const toFleetOptions = (plan: FleetPlan, rates: Rates = EXAMPLE_RATES): FleetOptions => ({ instances: plan.instances, framesPerChunk: plan.framesPerChunk, processesPerInstance: plan.chunks.heavy && !plan.chunks.light && !plan.chunks.gl ? rates.heavy.perInstance : rates.light.perInstance });
