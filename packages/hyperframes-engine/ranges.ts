/**
 * The arithmetic of split HyperFrames rendering, as pure functions (no browser, no FFmpeg, no file system), so that it
 * can be unit-tested: which slices of HyperFrames' plan a chunk touches, where a chunk sits on the timeline, what the
 * stitcher must check before it joins, how the sound is cut, and which ranges of a composition are heavy.
 *
 * Words:
 *   slice  a frame range of HyperFrames' own plan (`meta/chunks.json`). `renderChunkV2()` renders a sub-range of ONE
 *          slice per call. This repository plans few, long slices (SLICE_FRAMES), so a chunk is usually one part.
 *   chunk  a frame range of the coordinator's job, rendered by one process on one instance.
 *   part   the frames of one chunk inside one slice: one `renderChunkV2()` call, one closed GOP that starts on an IDR
 *          frame.
 */
import type { Segment } from '../core/src/planner.ts';

/** Frames per slice of HyperFrames' plan: 2 minutes at 30 fps, HyperFrames' own upper limit for a chunk. */
export const SLICE_FRAMES = 3600;

export type Slice = { index: number; startFrame: number; endFrame: number };
export type Part = { slice: number; startFrame: number; endFrame: number };

/** The parts of the frames [startFrame, endFrame): one per slice it touches, in order. Throws when the slices do not cover them. */
export function partsOf(slices: Slice[], startFrame: number, endFrame: number): Part[] {
  if (!(endFrame > startFrame)) throw new Error(`empty frame range ${startFrame}-${endFrame}`);
  const parts: Part[] = [];
  let cursor = startFrame;
  for (const slice of [...slices].sort((a, b) => a.startFrame - b.startFrame)) {
    if (slice.endFrame <= cursor || slice.startFrame >= endFrame) continue;
    if (slice.startFrame > cursor) break;
    const to = Math.min(endFrame, slice.endFrame);
    parts.push({ slice: slice.index, startFrame: cursor, endFrame: to });
    cursor = to;
    if (cursor >= endFrame) break;
  }
  if (cursor < endFrame) {
    const last = slices.reduce((end, slice) => Math.max(end, slice.endFrame), 0);
    throw new Error(`frames ${cursor}-${endFrame} are not in HyperFrames' plan, which has ${last} frames: the composition's data-duration and its timeline disagree`);
  }
  return parts;
}

/**
 * Where a part starts on the output timeline, in seconds: the offset its MPEG-TS packets are written with. Every chunk
 * carries absolute timestamps, so the chunks of a job can be joined byte after byte in any lengths. MPEG-TS counts in
 * 90 kHz ticks: for 24, 25, 30, 50 and 60 fps a frame is a whole number of ticks, so the offset is exact.
 */
export function tsOffsetSeconds(startFrame: number, fps: number): number {
  return startFrame / fps;
}
/** True when one frame is a whole number of 90 kHz ticks: then the joins are exact to the tick. */
export const exactTicks = (fps: number) => Number.isInteger(90000 / fps);

/** What a chunk run writes next to its video, and what the stitcher checks before the join. */
export type ChunkMeta = {
  version: 1;
  /** HyperFrames' execution-plan hash on the instance that rendered the chunk. Equal everywhere, or the instances planned different videos. */
  planHash: string;
  fps: number;
  width: number;
  height: number;
  startFrame: number;
  /** exclusive */
  endFrame: number;
  /** Video packets counted in the chunk's MPEG-TS: one per frame. */
  frames: number;
  parts: Part[];
  video: { name: string; bytes: number; sha256: string };
  /** GOP length in frames inside a part (a keyframe at least this often); every part starts with a keyframe. */
  gop: number;
  renderSeconds?: number;
  /** How the instance got HyperFrames' plan for this chunk: planned itself, or fetched the shared copy; and how long it took. */
  plan?: { source: 'local' | 'shared'; seconds: number };
};

/** Everything that would make the joined file wrong, as sentences. Empty: the chunks can be joined. */
export function checkChunks(metas: ChunkMeta[], expected: { startFrame: number; endFrame: number; planHash: string; fps: number; width: number; height: number }): string[] {
  const problems: string[] = [];
  if (!metas.length) return ['no chunks'];
  let cursor = expected.startFrame;
  metas.forEach((meta, index) => {
    const name = `chunk ${index} (frames ${meta.startFrame}-${meta.endFrame})`;
    if (meta.version !== 1) problems.push(`${name}: unknown description version ${meta.version}`);
    if (meta.planHash !== expected.planHash) problems.push(`${name}: rendered from another plan (${meta.planHash.slice(0, 12)} here ${expected.planHash.slice(0, 12)}): the instances did not see the same project, fonts or variables`);
    if (meta.fps !== expected.fps) problems.push(`${name}: ${meta.fps} fps, the job has ${expected.fps}`);
    if (meta.width !== expected.width || meta.height !== expected.height) problems.push(`${name}: ${meta.width}x${meta.height}, the job is ${expected.width}x${expected.height}`);
    if (meta.startFrame !== cursor) problems.push(`${name}: starts at frame ${meta.startFrame}, expected ${cursor}`);
    if (meta.frames !== meta.endFrame - meta.startFrame) problems.push(`${name}: holds ${meta.frames} frames instead of ${meta.endFrame - meta.startFrame}`);
    const partFrames = meta.parts.reduce((sum, part) => sum + part.endFrame - part.startFrame, 0);
    if (partFrames !== meta.endFrame - meta.startFrame) problems.push(`${name}: its parts hold ${partFrames} frames`);
    cursor = meta.endFrame;
  });
  if (cursor !== expected.endFrame) problems.push(`the chunks end at frame ${cursor}, the job at ${expected.endFrame}`);
  return problems;
}

/**
 * How the sound of a job is made. HyperFrames mixes the whole timeline once, while it plans (`audio.m4a`). The stitcher
 * puts that one track under the joined video, so there is no audio join at all and nothing can drift:
 *   none   the composition has no sound;
 *   copy   the job is the whole composition: the track is copied, cut to the video's length;
 *   cut    the job is a range: the track is cut at the range's start and re-encoded, because a copy can only cut at whole
 *          AAC frames (21 ms at 48 kHz) and the picture starts on a frame.
 */
export function audioPlan(input: { hasAudio: boolean; startFrame: number; endFrame: number; fps: number }): { mode: 'none' | 'copy' | 'cut'; startSeconds: number; seconds: number } {
  const seconds = (input.endFrame - input.startFrame) / input.fps;
  if (!input.hasAudio) return { mode: 'none', startSeconds: 0, seconds };
  return { mode: input.startFrame === 0 ? 'copy' : 'cut', startSeconds: input.startFrame / input.fps, seconds };
}

const COSTS = new Set(['light', 'gl', 'heavy']);
/**
 * Heavy ranges of a composition, read from its HTML without a browser. Two rules:
 *   - an element with `data-render-cost="heavy"` (or "gl", "light") and numeric `data-start` and `data-duration`;
 *   - a `<canvas>` that is itself a clip (has numeric `data-start` and `data-duration`): heavy, unless it says otherwise.
 * Times are seconds on the root timeline. Clips inside sub-compositions are not seen; mark the host element instead.
 */
export function segmentsFromHtml(html: string, fps: number, durationInFrames: number): Segment[] {
  const segments: Segment[] = [];
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const tag = match[1]!.toLowerCase();
    const attributes = match[2]!;
    const read = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(attributes)?.[1];
    const cost = read('data-render-cost')?.trim().toLowerCase();
    if (!(cost && COSTS.has(cost)) && tag !== 'canvas') continue;
    const start = Number(read('data-start'));
    const duration = Number(read('data-duration'));
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || read('data-start')?.trim() === '' ) continue;
    const startFrame = Math.max(0, Math.floor(start * fps));
    const endFrame = Math.min(durationInFrames, Math.ceil((start + duration) * fps));
    if (endFrame > startFrame) segments.push({ startFrame, endFrame, cls: (cost && COSTS.has(cost) ? cost : 'heavy') as Segment['cls'] });
  }
  return segments;
}

/** HyperFrames' CLI qualities to the distributed renderer's (which knows draft, standard and high, or a CRF). */
export function distributedQuality(quality: string | undefined): { quality: 'draft' | 'standard' | 'high'; crf?: number } {
  switch (quality ?? 'looks') {
    case 'draft': return { quality: 'draft' };
    case 'standard': return { quality: 'standard' };
    case 'high': case 'delivery': return { quality: 'high' };
    // `looks` is the CLI's default and means CRF 16 there.
    default: return { quality: 'standard', crf: 16 };
  }
}
