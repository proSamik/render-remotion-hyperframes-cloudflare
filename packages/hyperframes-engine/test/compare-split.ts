/**
 * Renders a HyperFrames composition once in one chunk and once in N chunks on N local instances, then checks that the
 * split render is the same video: frame count, duration, the sound under it, and the picture at every join and
 * everywhere else (SSIM per frame against the one-chunk render). Prints the wall time of both.
 *
 * Needs Chrome (HyperFrames finds or downloads it), ffmpeg and ffprobe. Run from examples/hyperframes-only:
 *   node ../../packages/core/bin/with-typescript-run.mjs ../../packages/hyperframes-engine/test/compare-split.ts \
 *     --project composition --chunks 3 [--frames 30-209] [--quality draft] [--crf 12] [--min-ssim 0.99] [--workers 1] [--skip-single]
 *     [--flash x,y,size]
 *
 * --flash: the composition shows a flash on every whole second at that square (the `long` example: 120,964,56) and its
 * sound beeps on every whole second. Every flash must begin on frame 0 of a second in the split render, and verify.mjs
 * --tone checks the beeps: together that is picture and sound in sync, to the frame.
 *
 * Why a low CRF by default: two encodes of the same pixels differ by their encoder's choices (a chunk starts a new
 * GOP). At CRF 12 that noise is far below what a wrong frame (a frame early or late, a missing font) would cost, so
 * the SSIM threshold separates the two. Draft quality on a busy scene gives SSIM about 0.90 between two encodes of the
 * SAME frames, which says nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderLocally } from '../../core/src/local.ts';
import type { JobRequest } from '../../core/src/types.ts';

const args = process.argv.slice(3);
const flag = (name: string) => { const at = args.lastIndexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const project = flag('project') ?? 'composition';
const chunks = Number(flag('chunks') ?? 3);
const quality = flag('quality') ?? 'high';
const crf = flag('crf') === 'none' ? undefined : Number(flag('crf') ?? 12);
const minSsim = Number(flag('min-ssim') ?? 0.99);
const workers = flag('workers') ? Number(flag('workers')) : 1;
const range = flag('frames')?.split('-').map(Number) as [number, number] | undefined;
const engine = resolve(import.meta.dirname, '..', 'engine.ts');
const env = { HYPERFRAMES_PROJECTS_DIR: process.cwd(), HYPERFRAMES_CLI_DIR: process.cwd() };
const clock = (ms: number) => { const total = Math.round(ms / 1000); const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`; };
const render = { project, quality, workers, ...(crf === undefined ? {} : { crf }), ...(range ? { frameRange: range } : {}) };

// N local instances share one machine here, so a chunk runs far slower than on its own instance: the coordinator's
// default deadline (frames / 1.5 fps, at least 300 s) is lifted. Hung chunks are still caught by the no-progress rule.
async function once(label: string, count: number): Promise<{ out: string; ms: number; joins: number[] }> {
  const out = resolve('out', `compare-${project}-${label}.mp4`);
  const request: JobRequest = { render, fleet: { chunks: count, instances: count, processesPerInstance: 1, duplicateStragglers: false, chunkDeadlineSeconds: 3600 } };
  const started = Date.now();
  const result = await renderLocally({ request, out, fleet: { engine, env, workDir: resolve(`.render-work-compare-${label}`) } });
  const ms = Date.now() - started;
  // The chunk grid the coordinator planned (`chunks: N` cuts equal parts), as frame numbers of the output.
  const first = range?.[0] ?? 0;
  const frames = result.frames;
  const parts = result.chunks.total;
  const joins = Array.from({ length: parts - 1 }, (_, part) => Math.round(((part + 1) * frames) / parts));
  console.error(`${label}: ${result.chunks.total} chunk(s), ${frames} frames from frame ${first}, ${clock(ms)} (${(ms / 1000).toFixed(1)} s)`);
  return { out, ms, joins };
}

function probe(file: string) {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets,duration,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' }));
  const video = json.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  const audio = json.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
  const [num, den] = String(video?.r_frame_rate ?? '30/1').split('/').map(Number);
  return { frames: Number(video?.nb_read_packets), seconds: Number(video?.duration), fps: num! / (den || 1), audioSeconds: audio ? Number(audio.duration) : null };
}

/** SSIM of every frame of b against the same frame of a (FFmpeg's ssim filter, `All` value). */
function ssimPerFrame(a: string, b: string): number[] {
  const text = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim=stats_file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return text.trim().split('\n').map((line) => Number(/All:([\d.]+)/.exec(line)?.[1]));
}

const problems: string[] = [];
const single = args.includes('--skip-single') && existsSync(resolve('out', `compare-${project}-1.mp4`)) ? { out: resolve('out', `compare-${project}-1.mp4`), ms: NaN, joins: [] } : await once('1', 1);
const split = await once(String(chunks), chunks);
const [a, b] = [probe(single.out), probe(split.out)];
const fps = a.fps;
const expected = a.frames;
if (b.frames !== expected) problems.push(`split render has ${b.frames} frames, one-chunk render ${expected}`);
if (Math.abs(b.seconds - expected / fps) > 0.5 / fps) problems.push(`split video lasts ${b.seconds} s, expected ${expected / fps}`);
if (a.audioSeconds !== null && (b.audioSeconds === null || Math.abs(b.audioSeconds - a.audioSeconds) > 0.03)) problems.push(`audio lasts ${b.audioSeconds} s, one-chunk render ${a.audioSeconds} s`);
const ssim = ssimPerFrame(single.out, split.out);
const worst = ssim.reduce((low, value, index) => (value < low.value ? { value, index } : low), { value: 1, index: -1 });
const atJoins = split.joins.map((frame) => ({ frame, ssim: Math.min(...[frame - 1, frame, frame + 1].filter((index) => index >= 0 && index < ssim.length).map((index) => ssim[index]!)) }));
for (const join of atJoins) if (!(join.ssim >= minSsim)) problems.push(`frames around the join at ${join.frame}: SSIM ${join.ssim.toFixed(4)} < ${minSsim}`);
if (!(worst.value >= minSsim)) problems.push(`frame ${worst.index}: SSIM ${worst.value.toFixed(4)} < ${minSsim}`);
/** Frames (of the output) where the square is bright. */
function flashFrames(file: string, square: number[]): number[] {
  const [x, y, size] = square;
  const text = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-vf', `crop=${size}:${size}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const values = [...text.matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  return values.flatMap((value, index) => (value > 128 ? [index] : []));
}
let flash: { frames: number; offSecond: number[] } | null = null;
if (flag('flash')) {
  const first = range?.[0] ?? 0;
  const frames = flashFrames(split.out, flag('flash')!.split(',').map(Number));
  // Every flash must begin on frame 0 of a second (the composition shows it for the first 0.1 s, 3 frames, give or
  // take one for rounding in the page). A flash that begins a frame early or late is a picture out of sync.
  const starts = frames.filter((frame) => !frames.includes(frame - 1));
  const offSecond = starts.filter((frame) => (frame + first) % fps !== 0);
  const seconds = new Set(starts.map((frame) => Math.floor((frame + first) / fps)));
  flash = { frames: frames.length, offSecond };
  if (offSecond.length) problems.push(`the flash begins on frames that are not at a whole second: ${offSecond.slice(0, 10).join(', ')}`);
  if (seconds.size < Math.floor(expected / fps)) problems.push(`the flash is seen in ${seconds.size} seconds of ${Math.floor(expected / fps)}`);
}
const report = {
  project, quality, crf: crf ?? null, frames: { single: a.frames, split: b.frames }, seconds: { single: a.seconds, split: b.seconds }, audioSeconds: { single: a.audioSeconds, split: b.audioSeconds },
  wall: { single: Number.isNaN(single.ms) ? null : clock(single.ms), split: clock(split.ms), speedup: Number.isNaN(single.ms) ? null : Number((single.ms / split.ms).toFixed(2)) },
  ssim: { worst: Number(worst.value.toFixed(4)), worstFrame: worst.index, mean: Number((ssim.reduce((sum, value) => sum + value, 0) / ssim.length).toFixed(4)), joins: atJoins.map((join) => ({ frame: join.frame, ssim: Number(join.ssim.toFixed(4)) })) },
  ...(flash ? { flash } : {}),
  ok: problems.length === 0, problems,
};
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
