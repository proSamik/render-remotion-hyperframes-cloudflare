/**
 * Output resolution: names, even sizes without cropping, bitrates, and the rate change for the planner. Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXAMPLE_RATES, planFleet, TIERS } from '../src/planner.ts';
import { bitrateFor, normalizeQuality, outputSize, ratesForOutput, resolutionFactors } from '../src/resolution.ts';

test('quality names: aliases, the composition size by default, unknown names refused', () => {
  assert.equal(normalizeQuality(undefined), 'composition');
  assert.equal(normalizeQuality('4K'), '2160p');
  assert.equal(normalizeQuality('2k'), '1440p');
  assert.equal(normalizeQuality('999p'), null);
  assert.throws(() => outputSize(1920, 1080, '999p'), /Unknown quality/);
});

test('output sizes are even, keep the aspect ratio and cut nothing; Remotion rounds to the same size', () => {
  const cases: Array<[number, number, string, number, number]> = [
    [1920, 1080, '360p', 640, 360], [1920, 1080, '480p', 854, 480], [1920, 1080, '720p', 1280, 720], [1920, 1080, '1080p', 1920, 1080],
    [1920, 1080, '1440p', 2560, 1440], [1920, 1080, '4k', 3840, 2160], [1080, 1920, '480p', 480, 854], [1080, 1080, '720p', 720, 720],
    [1280, 720, '1080p', 1920, 1080], [3840, 2160, '720p', 1280, 720], [1920, 1080, 'composition', 1920, 1080],
  ];
  for (const [w, h, q, ow, oh] of cases) {
    const size = outputSize(w, h, q);
    assert.deepEqual([size.width, size.height], [ow, oh], `${w}x${h} ${q}`);
    // what Remotion will produce with this scale (round(side x scale)), and both sides even
    assert.deepEqual([Math.round(w * size.scale), Math.round(h * size.scale)], [ow, oh], `${w}x${h} ${q} scale ${size.scale}`);
    assert.equal(ow % 2 + oh % 2, 0);
  }
});

test('bitrate ladder', () => {
  assert.equal(bitrateFor(640, 360), 1_000_000);
  assert.equal(bitrateFor(854, 480), 2_500_000);
  assert.equal(bitrateFor(1920, 1080), 10_000_000);
  assert.equal(bitrateFor(3840, 2160), 35_000_000);
  assert.equal(outputSize(1920, 1080, '720p').bitrate, 5_000_000);
});

test('rates per output size: 1 at 1080p, cheaper below, dearer above, never linear in pixels; the plan follows', () => {
  const at1080 = resolutionFactors(1920, 1080);
  const at480 = resolutionFactors(854, 480);
  const at4k = resolutionFactors(3840, 2160);
  for (const cls of ['light', 'gl', 'heavy'] as const) {
    assert.equal(at1080[cls].fps, 1);
    assert.ok(at480[cls].fps > 1 && at480[cls].cpu < 1);
    assert.ok(at4k[cls].fps < 1 && at4k[cls].cpu > 1 && at4k[cls].cpu < 4, '4x the pixels costs less than 4x');
  }
  const info = { fps: 30, frames: 18_000, segments: [{ startFrame: 3_000, endFrame: 4_500, cls: 'heavy' as const }] };
  const small = planFleet(info, TIERS.standard, ratesForOutput(EXAMPLE_RATES, 854, 480), { maxInstances: 500 });
  const big = planFleet(info, TIERS.standard, ratesForOutput(EXAMPLE_RATES, 3840, 2160), { maxInstances: 500 });
  // the same finish-time target needs more instances at 4K than at 480p
  assert.ok(big.wantedInstances > small.wantedInstances, `${big.wantedInstances} > ${small.wantedInstances}`);
});
