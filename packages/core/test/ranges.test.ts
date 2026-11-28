/**
 * Cutting a job into chunks: planRanges() and the coordinator's chunkRanges(). Pure functions. Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkRanges } from '../src/coordinator.ts';
import { planRanges, type ChunkRange } from '../src/planner.ts';
import type { Plan } from '../src/types.ts';

const lengths = (ranges: ChunkRange[]) => ranges.map((range) => range.endFrame - range.startFrame);
/** The ranges cover [from, to) end to end, in order, none empty. */
function covers(ranges: ChunkRange[], from: number, to: number) {
  assert.equal(ranges[0]!.startFrame, from);
  assert.equal(ranges[ranges.length - 1]!.endFrame, to);
  for (let index = 1; index < ranges.length; index += 1) assert.equal(ranges[index]!.startFrame, ranges[index - 1]!.endFrame);
  for (const range of ranges) assert.ok(range.endFrame > range.startFrame);
}

test('fixed grid (Remotion): equal chunks except the last, inside the bounds, segments ignored', () => {
  const ranges = planRanges({ startFrame: 0, endFrame: 1000, fps: 30, targetChunks: 4, variable: false, segments: [{ startFrame: 100, endFrame: 200, cls: 'heavy' }] });
  assert.deepEqual(lengths(ranges), [250, 250, 250, 250]);
  // max 30 s = 900 frames; min 2 s = 60 frames
  assert.deepEqual(lengths(planRanges({ startFrame: 0, endFrame: 2000, fps: 30, targetChunks: 1 })), [900, 900, 200]);
  assert.deepEqual(lengths(planRanges({ startFrame: 0, endFrame: 200, fps: 30, targetChunks: 50 })), [60, 60, 60, 20]);
});

/** Cost of a chunk: light frames 1, heavy frames 4 (the default weights). */
const costOf = (range: ChunkRange, heavy: [number, number][]) => { let cost = 0; for (let frame = range.startFrame; frame < range.endFrame; frame += 1) cost += heavy.some(([from, to]) => frame >= from && frame < to) ? 4 : 1; return cost; };

test('variable chunks: equal parts without a short tail; over a heavy range, chunks of equal cost', () => {
  const plain = planRanges({ startFrame: 0, endFrame: 1000, fps: 30, targetChunks: 3, variable: true });
  covers(plain, 0, 1000);
  assert.deepEqual(lengths(plain), [333, 334, 333]);
  // 60 s at 30 fps, heavy (4x) from 20 s to 40 s, 4 chunks: total cost 1200 + 2400 = 3600, 900 per chunk.
  const ranges = planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 4, variable: true, segments: [{ startFrame: 600, endFrame: 1200, cls: 'heavy' }] });
  covers(ranges, 0, 1800);
  assert.deepEqual(lengths(ranges), [675, 225, 225, 675]);
  assert.deepEqual(ranges.map((range) => costOf(range, [[600, 1200]])), [900, 900, 900, 900]);
  // equal lengths would have given costs of 450, 1350, 1350, 450: the slowest chunk three times the fastest
  assert.deepEqual(lengths(planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 4, variable: false, segments: [{ startFrame: 600, endFrame: 1200, cls: 'heavy' }] })), [450, 450, 450, 450]);
});

test('variable chunks: weights, the minimum length, the cap on heavy frames', () => {
  const segments = [{ startFrame: 600, endFrame: 1200, cls: 'heavy' as const }];
  // weight 2 instead of 4: total 2400, 600 per chunk
  assert.deepEqual(lengths(planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 4, variable: true, segments, weights: { heavy: 2 } })), [600, 300, 300, 600]);
  // a very heavy range would ask for tiny chunks: none is shorter than min (2 s = 60 frames)
  const tiny = planRanges({ startFrame: 0, endFrame: 900, fps: 30, targetChunks: 8, variable: true, segments: [{ startFrame: 0, endFrame: 30, cls: 'heavy' }], weights: { heavy: 100 } });
  covers(tiny, 0, 900);
  assert.ok(lengths(tiny).every((length) => length >= 60), `lengths ${lengths(tiny)}`);
  // at most 1 s of heavy frames per chunk: the two chunks over the heavy range are split again
  const capped = planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 4, variable: true, segments, heavyMaxSeconds: 5 });
  covers(capped, 0, 1800);
  assert.ok(capped.every((range) => { let heavy = 0; for (let frame = range.startFrame; frame < range.endFrame; frame += 1) if (frame >= 600 && frame < 1200) heavy += 1; return heavy <= 150; }), `lengths ${lengths(capped)}`);
  // the number of chunks keeps an average chunk inside [min, max]
  assert.equal(planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 100, variable: true }).length, 30);
  assert.equal(planRanges({ startFrame: 0, endFrame: 1800, fps: 30, targetChunks: 1, variable: true, maxSeconds: 10 }).length, 6);
});

test('a range that does not start at 0 keeps its frames', () => {
  const ranges = planRanges({ startFrame: 45, endFrame: 201, fps: 30, targetChunks: 3, variable: true, minSeconds: 1 });
  covers(ranges, 45, 201);
  assert.deepEqual(lengths(ranges), [52, 52, 52]);
});

const plan = (extra: Partial<Plan> = {}): Plan => ({ fps: 30, durationInFrames: 1800, width: 1920, height: 1080, chunkable: true, ...extra });

test('chunkRanges: the default grid is unchanged (frames / processes, at least 30 frames)', () => {
  assert.deepEqual(lengths(chunkRanges(plan(), 0, 360, { instances: 2, processesPerInstance: 2 }, 4)), [90, 90, 90, 90]);
  assert.deepEqual(lengths(chunkRanges(plan(), 0, 400, { framesPerChunk: 150 }, 4)), [150, 150, 100]);
  assert.deepEqual(lengths(chunkRanges(plan(), 0, 100, {}, 12)), [30, 30, 30, 10]);
});

test('chunkRanges: `chunks: N` gives N chunks, equal parts when the engine allows any lengths', () => {
  assert.deepEqual(lengths(chunkRanges(plan({ variableChunks: true }), 0, 1000, { chunks: 3 }, 1)), [333, 334, 333]);
  assert.deepEqual(lengths(chunkRanges(plan(), 0, 1000, { chunks: 3 }, 1)), [334, 334, 332]);
  assert.equal(chunkRanges(plan({ variableChunks: true }), 0, 1800, { chunks: 1 }, 8).length, 1);
  // never below 30 frames a chunk
  assert.equal(chunkRanges(plan({ variableChunks: true }), 0, 90, { chunks: 10 }, 1).length, 3);
});

test('chunkRanges: `chunks: auto` follows the processes and the heavy ranges', () => {
  const segments = [{ startFrame: 600, endFrame: 1200, cls: 'heavy' as const }];
  const ranges = chunkRanges(plan({ variableChunks: true, segments }), 0, 1800, { chunks: 'auto' }, 4);
  covers(ranges, 0, 1800);
  assert.deepEqual(lengths(ranges), [675, 225, 225, 675]);
  assert.deepEqual(lengths(chunkRanges(plan({ variableChunks: true, segments }), 0, 1800, { chunks: 'auto', costWeights: { heavy: 2 } }, 4)), [600, 300, 300, 600]);
  // without variableChunks (Remotion) 'auto' is a fixed grid
  assert.deepEqual(lengths(chunkRanges(plan({ segments }), 0, 1800, { chunks: 'auto' }, 4)), [450, 450, 450, 450]);
  // bounds in seconds
  assert.ok(chunkRanges(plan({ variableChunks: true }), 0, 1800, { chunks: 'auto', chunkSeconds: { max: 10 } }, 1).every((range) => range.endFrame - range.startFrame <= 300));
});
