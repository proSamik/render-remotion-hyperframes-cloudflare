/**
 * Output resolution as a job option: a name ("480p", "4k") or the composition's own size, turned into Remotion's
 * `scale`, the output size, a bitrate, and the rate change the planner needs. Pure functions.
 *
 *   quality     the SHORT side of the output (the height of a landscape video): 360p, 480p, 720p, 1080p, 1440p, 2160p;
 *               "2k" and "4k" are read as 1440p and 2160p; "composition" keeps the composition's size.
 *   scale       Remotion's `scale` option. Use the SAME value for every chunk of a job: the join copies the chunks'
 *               streams, so chunks of different sizes give a broken file.
 *   even sizes  H.264 needs even sides. Remotion rounds `width x scale` and, when that is odd, takes pixels off the
 *               composition until it is even (1920 x 1080 at 480p gives 852 x 480, two columns cut). outputSize() picks
 *               a scale that lands on even sides without cutting anything (854 x 480).
 *
 * Above the composition's size, layers that are rendered to video first (HyperFrames proxies, any pre-rendered
 * overlay) must be rendered for the output size too, or they are upscaled and soft: see docs/resolution.md.
 */

export const QUALITY_SHORT_SIDE = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 } as const;
export type QualityName = keyof typeof QUALITY_SHORT_SIDE | 'composition';
export const QUALITIES: QualityName[] = [...(Object.keys(QUALITY_SHORT_SIDE) as QualityName[]), 'composition'];
const ALIASES: Record<string, QualityName> = { '2k': '1440p', '4k': '2160p', project: 'composition', source: 'composition', original: 'composition' };

/** A quality name, or null when the value is not one. Nothing given = the composition's size. */
export function normalizeQuality(quality: unknown): QualityName | null {
  if (quality === undefined || quality === null || quality === '') return 'composition';
  const name = String(quality).trim().toLowerCase();
  const known = ALIASES[name] ?? name;
  return (QUALITIES as string[]).includes(known) ? (known as QualityName) : null;
}

/**
 * H.264 bitrate in bit/s for 30 fps with x264 `veryfast` and a keyframe every second: the common streaming ladder.
 * 1080p at 10 Mbit/s is what the measurements in this repository used. Scale it with the frame rate if yours is
 * higher, or use `crf` instead if file size does not matter.
 */
export const QUALITY_BITRATES: Record<keyof typeof QUALITY_SHORT_SIDE, number> = { '360p': 1_000_000, '480p': 2_500_000, '720p': 5_000_000, '1080p': 10_000_000, '1440p': 16_000_000, '2160p': 35_000_000 };

/** The preset of the smallest named size whose short side covers width x height. */
export function bitrateFor(width: number, height: number): number {
  const short = Math.min(width, height);
  for (const [name, side] of Object.entries(QUALITY_SHORT_SIDE)) if (short <= side * 1.02) return QUALITY_BITRATES[name as keyof typeof QUALITY_SHORT_SIDE];
  return QUALITY_BITRATES['2160p'];
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export type OutputSize = { quality: QualityName; scale: number; width: number; height: number; bitrate: number };

/** Remotion `scale`, output size and bitrate for a composition of width x height. */
export function outputSize(width: number, height: number, quality: unknown = 'composition'): OutputSize {
  const name = normalizeQuality(quality);
  if (!name) throw new Error(`Unknown quality "${String(quality)}". Use one of ${QUALITIES.join(', ')} (2k, 4k).`);
  const done = (scale: number, w: number, h: number): OutputSize => ({ quality: name, scale, width: w, height: h, bitrate: bitrateFor(w, h) });
  if (name === 'composition') return done(1, even(width), even(height));
  const short = QUALITY_SHORT_SIDE[name];
  const exact = short / Math.min(width, height);
  if (Math.abs(exact - 1) < 0.01) return done(1, even(width), even(height));
  const landscape = width >= height;
  const long = even((landscape ? width : height) * exact);
  const [targetWidth, targetHeight] = landscape ? [long, short] : [short, long];
  // Remotion sizes the output as round(side x scale): try the scales that hit both targets exactly.
  for (const scale of [targetWidth / width, targetHeight / height, exact]) {
    if (scale < 0.1 || scale > 16) continue;
    if (Math.round(width * scale) === targetWidth && Math.round(height * scale) === targetHeight) return done(scale, targetWidth, targetHeight);
  }
  // No single scale hits both (unusual aspect ratios): Remotion's own rounding, which may cut a pixel or two.
  let w = width; while (Math.round(w * exact) % 2) w -= 1;
  let h = height; while (Math.round(h * exact) % 2) h -= 1;
  return done(exact, Math.round(w * exact), Math.round(h * exact));
}

/**
 * How frame cost changes with output pixels, relative to 1080p (2,073,600 px), per cost class: `fps` multiplies the
 * frames per second of one process, `cpu` the vCPU-seconds per frame. Measured on Cloudflare standard-4 (4 vCPU, no
 * GPU) by the prototype of this design: the same 4-minute mixed range sampled at every size (docs/resolution.md).
 * It is NOT linear in pixels: a frame has a fixed part (React, layout, seeking video, WebGL draw calls) and a part
 * that grows with pixels (raster, screenshot, JPEG, x264). Measure your own content the same way.
 */
export const RESOLUTION_FACTORS = [
  { pixels: 0.111, light: { fps: 1.43, cpu: 0.654 }, gl: { fps: 1.494, cpu: 0.755 }, heavy: { fps: 1.158, cpu: 0.907 } },
  { pixels: 0.198, light: { fps: 1.282, cpu: 0.737 }, gl: { fps: 1.434, cpu: 0.777 }, heavy: { fps: 1.136, cpu: 0.913 } },
  { pixels: 0.444, light: { fps: 1.108, cpu: 0.907 }, gl: { fps: 1.178, cpu: 0.93 }, heavy: { fps: 1.018, cpu: 0.97 } },
  { pixels: 1, light: { fps: 1, cpu: 1 }, gl: { fps: 1, cpu: 1 }, heavy: { fps: 1, cpu: 1 } },
  { pixels: 1.778, light: { fps: 0.697, cpu: 1.561 }, gl: { fps: 0.753, cpu: 1.314 }, heavy: { fps: 0.925, cpu: 1.057 } },
  { pixels: 4, light: { fps: 0.431, cpu: 2.405 }, gl: { fps: 0.476, cpu: 1.843 }, heavy: { fps: 0.732, cpu: 1.232 } },
] as const;

type Classes = 'light' | 'gl' | 'heavy';
const CLASSES: Classes[] = ['light', 'gl', 'heavy'];

/** Multipliers for an output of width x height, interpolated on log(pixels) between the measured rows. */
export function resolutionFactors(width: number, height: number): Record<Classes, { fps: number; cpu: number }> {
  const ratio = Math.max(0.01, (width * height) / (1920 * 1080));
  const rows = RESOLUTION_FACTORS;
  const at = (row: (typeof rows)[number]) => Object.fromEntries(CLASSES.map((cls) => [cls, { ...row[cls] }])) as Record<Classes, { fps: number; cpu: number }>;
  if (ratio <= rows[0].pixels) return at(rows[0]);
  if (ratio >= rows[rows.length - 1]!.pixels) return at(rows[rows.length - 1]!);
  const upper = rows.findIndex((row) => row.pixels >= ratio);
  const a = rows[upper - 1]!; const b = rows[upper]!;
  if (b.pixels === ratio) return at(b);
  const t = (Math.log(ratio) - Math.log(a.pixels)) / (Math.log(b.pixels) - Math.log(a.pixels));
  const mix = (x: number, y: number) => Math.exp(Math.log(x) + t * (Math.log(y) - Math.log(x)));
  return Object.fromEntries(CLASSES.map((cls) => [cls, { fps: mix(a[cls].fps, b[cls].fps), cpu: mix(a[cls].cpu, b[cls].cpu) }])) as Record<Classes, { fps: number; cpu: number }>;
}

/** 1080p rates (planner.ts `Rates`) moved to another output size. Rates you measured at that size need no moving. */
export function ratesForOutput<R extends Record<Classes, { fps: number }>>(rates: R, width: number, height: number): R {
  const factors = resolutionFactors(width, height);
  const moved = { ...rates };
  for (const cls of CLASSES) moved[cls] = { ...rates[cls], fps: rates[cls].fps * factors[cls].fps };
  return moved;
}
