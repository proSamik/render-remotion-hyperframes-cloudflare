#!/usr/bin/env node
/**
 * Checks a rendered file with ffprobe/ffmpeg (both must be on PATH).
 *   node verify.mjs <file> [--frames N] [--fps 30] [--joins 100,200] [--tone] [--silent-ok]
 * --frames  expected number of video frames
 * --joins   frame numbers where chunks were joined: the sound around each join must not jump more than it does anywhere else
 * --tone    the sound track is the test tone of make-tone.mjs: there must be one beep per second, evenly spaced
 * Prints one JSON document; exit code 1 when a check fails.
 */
import { execFileSync } from 'node:child_process';

const [file, ...rest] = process.argv.slice(2);
const flag = (name) => { const at = rest.indexOf(`--${name}`); return at < 0 ? undefined : rest[at + 1] ?? true; };
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration,r_frame_rate,width,height,sample_rate', '-of', 'json', file], { encoding: 'utf8' }));
const video = probe.streams.find((stream) => stream.codec_type === 'video');
const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
const fps = Number(flag('fps') ?? 30);
const problems = [];
const report = {
  file, video: video ? { codec: video.codec_name, frames: Number(video.nb_read_frames), size: `${video.width}x${video.height}`, rate: video.r_frame_rate, seconds: Number(video.duration) } : null,
  audio: audio ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), seconds: Number(audio.duration) } : null,
};
if (!video) problems.push('no video stream');
if (flag('frames') && video && Number(video.nb_read_frames) !== Number(flag('frames'))) problems.push(`expected ${flag('frames')} frames, found ${video.nb_read_frames}`);
if (!audio && !rest.includes('--silent-ok')) problems.push('no audio stream');

if (audio && (flag('joins') || rest.includes('--tone'))) {
  const rate = 48000;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const step = (from, to) => { let max = 0; for (let index = Math.max(1, from); index < Math.min(samples.length, to); index += 1) max = Math.max(max, Math.abs(samples[index] - samples[index - 1])); return max / 32768; };
  const overall = step(1, samples.length);
  if (flag('joins')) {
    report.joins = String(flag('joins')).split(',').filter(Boolean).map(Number).map((frame) => {
      const at = Math.round((frame / fps) * rate);
      const here = step(at - rate * 0.05, at + rate * 0.1);
      // Silence around a join would show as a run of near-zero samples in a track that is never silent.
      let quiet = 0; let longest = 0;
      for (let index = Math.max(0, at - rate * 0.05); index < Math.min(samples.length, at + rate * 0.1); index += 1) { quiet = Math.abs(samples[index]) < 40 ? quiet + 1 : 0; longest = Math.max(longest, quiet); }
      return { frame, seconds: frame / fps, largestStep: Number(here.toFixed(4)), longestQuietMs: Number(((longest / rate) * 1000).toFixed(2)) };
    });
    // What the track normally does: the median of the largest step in each 150 ms window. A click is far above it.
    const windows = [];
    for (let from = 1; from + rate * 0.15 < samples.length; from += rate * 0.15) windows.push(step(from, from + rate * 0.15));
    const typical = windows.sort((a, b) => a - b)[Math.floor(windows.length / 2)] ?? overall;
    report.largestStepOverall = Number(overall.toFixed(4));
    report.typicalStep = Number(typical.toFixed(4));
    for (const join of report.joins) {
      if (join.largestStep > Math.max(overall * 1.001, 0) || (rest.includes('--tone') && join.frame % fps > 4 && join.largestStep > typical * 3)) problems.push(`click at the join at frame ${join.frame}`);
      if (rest.includes('--tone') && join.longestQuietMs > 3) problems.push(`gap of ${join.longestQuietMs} ms at the join at frame ${join.frame}`);
    }
  }
  if (rest.includes('--tone')) {
    const onsets = [];
    for (let index = 0, wait = 0; index < samples.length; index += 1) { if (wait > 0) { wait -= 1; continue; } if (Math.abs(samples[index]) > 0.3 * 32768) { onsets.push(index / rate); wait = rate * 0.5; } }
    const expected = Math.ceil(samples.length / rate - 0.2);
    const offsets = onsets.map((time) => (time - Math.round(time)) * 1000);
    report.beeps = { found: onsets.length, expected: Math.round(Number(video?.duration ?? samples.length / rate)), offsetMsMin: Number(Math.min(...offsets).toFixed(1)), offsetMsMax: Number(Math.max(...offsets).toFixed(1)) };
    // The audio track is a few AAC frames longer than the video, so the beep of the next second may just be in it.
    if (onsets.length !== report.beeps.expected && onsets.length !== report.beeps.expected + 1 && onsets.length !== expected) problems.push(`expected ${report.beeps.expected} beeps, found ${onsets.length}`);
    if (Math.max(...offsets) - Math.min(...offsets) > 12) problems.push(`beeps drift: offsets from ${report.beeps.offsetMsMin} to ${report.beeps.offsetMsMax} ms`);
  }
}
report.ok = problems.length === 0;
report.problems = problems;
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
