/**
 * The streaming join against the way combineChunks() joins: the same chunks, joined both ways, must give the same
 * packets. Uses the ffmpeg on the PATH to make four small chunks; skipped when there is none.
 * (With real Remotion chunks and Remotion's own FFmpeg the MP4 of both ways is the same file byte for byte: CI checks
 * that after the example render, with ../scripts/compare-joins.ts.)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { audioCut, streamingStitch } from '../container/streaming-stitch.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && /libx264/.test(String(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout));
const run = (args: string[], cwd: string) => { const result = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', ...args], { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
const packets = (file: string, cwd: string) => ({ video: run(['-i', file, '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'], cwd).trim(), audio: run(['-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'], cwd).trim() });
const ffmpeg = (cwd: string) => (args: string[], stdio: import('node:child_process').StdioOptions) => spawn('ffmpeg', args, { cwd, stdio });

test('audioCut: the padding of every chunk is cut off on a whole AAC frame', () => {
  const frame = (1024 / 48000) * 1_000_000;
  // 1 s chunks at 48 kHz are 46.875 AAC frames. The chunk borders, rounded to whole frames: 0, 47, 94, 141, 188.
  const frames = (index: number) => { const cut = audioCut(index, 4, 1); return { from: Math.round(cut.inpoint / frame), length: Math.round((cut.outpoint - cut.inpoint) / frame) }; };
  assert.deepEqual(frames(0), { from: 0, length: 2 + 47 - 1 }); // the first file has no extra frames in front, only the encoder's priming
  assert.deepEqual(frames(1), { from: 4, length: 47 - 1 }); // 2 frames of priming and 2 extra frames skipped; one frame off the end
  assert.deepEqual(frames(2), { from: 4, length: 47 - 1 });
  assert.deepEqual(frames(3), { from: 4, length: 47 }); // nothing is taken off at the very end
  // 29.97 fps, 44.1 kHz: still whole frames
  const odd = audioCut(5, 9, 150 / 29.97, 44100);
  assert.ok(Math.abs(odd.inpoint / ((1024 / 44100) * 1_000_000) - 4) < 1e-9);
});

test('streaming join: same packets as the join with every chunk on disk, as MP4 and as fragmented MP4, with chunks released in order', { skip: hasFfmpeg ? false : 'no ffmpeg with libx264 on the PATH' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rrh-stitch-'));
  try {
    const count = 4;
    const fps = 30;
    // Video: one stream cut into 1 s MPEG-TS pieces with closed GOPs. Audio: per chunk an ADTS file longer than a chunk, like Remotion's padded ones.
    run(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=${fps}`, '-t', String(count), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p', '-f', 'segment', '-segment_time', '1', '-segment_format', 'mpegts', 'chunk-%04d.ts'], dir);
    for (let index = 0; index < count; index += 1) run(['-f', 'lavfi', '-i', `sine=frequency=${300 + 100 * index}:sample_rate=48000`, '-t', '1.2', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', `chunk-${String(index).padStart(4, '0')}.aac`], dir);
    const chunks = Array.from({ length: count }, (_, index) => ({ video: `chunk-${String(index).padStart(4, '0')}.ts`, audio: `chunk-${String(index).padStart(4, '0')}.aac` }));

    // The reference, in combineChunks()' three steps: concat demuxer over all audio files at once, concat protocol for the video, mux.
    await writeFile(join(dir, 'all.txt'), chunks.map((chunk, index) => { const cut = audioCut(index, count, 1); return `file '${join(dir, chunk.audio)}'\ninpoint ${cut.inpoint}us\noutpoint ${cut.outpoint}us`; }).join('\n'));
    run(['-f', 'concat', '-safe', '0', '-i', 'all.txt', '-c:a', 'copy', '-vn', '-y', 'audio.aac'], dir);
    run(['-i', `concat:${chunks.map((chunk) => chunk.video).join('|')}`, '-i', 'audio.aac', '-c:v', 'copy', '-c:a', 'copy', '-r', String(fps), '-movflags', 'faststart', '-y', 'reference.mp4'], dir);
    const reference = packets('reference.mp4', dir);

    const released: number[] = [];
    const feed = () => ({ ready: async () => undefined, release: async (index: number) => { released.push(index); } });
    const shared = { ffmpeg: ffmpeg(dir), dir, chunks, fps, framesPerChunk: fps, frames: count * fps, comment: 'comment=test' };
    // audioBatch 1: every chunk's audio goes through its own run of the demuxer. The result must not depend on the batches.
    const mp4 = await streamingStitch({ ...shared, feed: feed(), mode: 'mp4', outputName: 'stream.mp4', audioBatch: 1 });
    assert.deepEqual(mp4, { frames: count * fps, streamed: false });
    assert.deepEqual(packets('stream.mp4', dir), reference);
    assert.deepEqual(released, [0, 1, 2, 3]);

    await streamingStitch({ ...shared, feed: feed(), mode: 'fmp4', outputName: 'fragmented.mp4', audioBatch: 3 });
    assert.deepEqual(packets('fragmented.mp4', dir), reference);

    // with an output the fragmented MP4 goes to the sink and never to the disk
    const parts: Buffer[] = [];
    const piped = await streamingStitch({ ...shared, feed: feed(), mode: 'fmp4', outputName: 'never-written.mp4', output: { name: 'out.mp4', write: async (stream) => { for await (const data of stream) parts.push(Buffer.from(data)); } } });
    assert.equal(piped.streamed, true);
    await assert.rejects(readFile(join(dir, 'never-written.mp4')));
    assert.ok(Buffer.concat(parts).equals(await readFile(join(dir, 'fragmented.mp4'))));

    // a join that does not have the frames it should have is an error, not an output
    await assert.rejects(streamingStitch({ ...shared, feed: feed(), chunks: chunks.slice(0, 3), frames: 3 * fps + 30, framesPerChunk: 40, mode: 'mp4', outputName: 'short.mp4' }), /frames, expected|chunks, the task has/);
    await assert.rejects(streamingStitch({ ...shared, feed: feed(), chunks: [...chunks.slice(0, 3), { video: 'missing.ts', audio: chunks[3]!.audio }], mode: 'mp4', outputName: 'broken.mp4' }));
    await assert.rejects(readFile(join(dir, 'broken.mp4')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
