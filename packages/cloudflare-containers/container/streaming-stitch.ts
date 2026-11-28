/**
 * A streaming join of Remotion chunks: the same result as combineChunks(), without all chunks on the disk at once and,
 * as a fragmented MP4, without the output on the disk at all.
 *
 * combineChunks() does three things for H.264 + AAC (read in @remotion/renderer 4.0.530; check again when you upgrade):
 *   video  it hands FFmpeg `concat:chunk0.ts|chunk1.ts|...`. That is the concat PROTOCOL: the files are read one after
 *          the other as one MPEG-TS stream. Here the same bytes arrive on a pipe, chunk after chunk, in order.
 *   audio  FFmpeg's concat DEMUXER over the padded .aac files with an `inpoint` and `outpoint` per file, stream copy.
 *          Each chunk was rendered with extra AAC frames on both sides (`forSeamlessAacConcatenation`); the in and out
 *          points cut them off. They depend only on the chunk's index, so the demuxer can run over one batch of chunks
 *          after the other while they arrive, and the ADTS outputs are simply appended.
 *   mux    `-c:v copy -c:a copy -r <fps>` and Remotion's metadata comment; `-movflags faststart` for an MP4.
 *
 * Two outputs:
 *   mp4   a normal MP4 in `dir`. The disk holds the output and a window of chunks. The output must fit the disk.
 *   fmp4  a fragmented MP4 written to a pipe. With `output` it is uploaded part by part while it is produced, and the
 *         disk holds the window of chunks only. Players learn the duration by reading the fragments.
 *
 * A chunk's files are deleted (`feed.release`) when both its video and its audio were consumed.
 */
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ChunkFeed, StreamOutput } from '../../core/src/types.ts';

/** Microseconds of one AAC frame (1024 samples). */
const aacFrame = (sampleRate: number) => (1024 / sampleRate) * 1_000_000;
/** The whole number of AAC frames nearest to a time. A fraction a hair under one half counts as a half (float noise). */
const alignedMicros = (seconds: number, sampleRate: number) => { const frames = (seconds * 1_000_000) / aacFrame(sampleRate); return (frames % 1 > 0.4999999 ? Math.ceil(frames) : Math.floor(frames)) * aacFrame(sampleRate); };

/**
 * Where the real audio of chunk `index` sits inside its padded file, as the concat demuxer wants it.
 * Not the first chunk: the encoder's 2 frames of priming and the 2 extra frames that were asked for are skipped.
 * The first chunk has only the priming, which the demuxer handles, so it starts at 0 and its end is 2 frames later.
 * The out point is exclusive; one frame is taken off so that neighbours do not overlap, except at the very end.
 */
export function audioCut(index: number, count: number, chunkSeconds: number, sampleRate = 48000): { inpoint: number; outpoint: number } {
  const frame = aacFrame(sampleRate);
  const real = alignedMicros((index + 1) * chunkSeconds, sampleRate) - alignedMicros(index * chunkSeconds, sampleRate);
  const inpoint = index === 0 ? 0 : 4 * frame;
  return { inpoint, outpoint: (index === 0 ? 2 * frame : inpoint) + real - (index === count - 1 ? 0 : frame) };
}

export type StitchInput = {
  /** Starts FFmpeg. The engine passes Remotion's own binary, so the muxer is the one combineChunks() would use. */
  ffmpeg: (args: string[], stdio: StdioOptions) => ChildProcess;
  dir: string;
  /** Per chunk, in order: the file names in `dir`. */
  chunks: { video: string; audio: string }[];
  feed: ChunkFeed;
  fps: number;
  framesPerChunk: number;
  /** Frames of the whole output: the muxer's own count must equal it. */
  frames: number;
  mode: 'mp4' | 'fmp4';
  outputName: string;
  /** fmp4 only: where the stream goes instead of a file in `dir`. */
  output?: StreamOutput;
  comment: string;
  sampleRate?: number;
  /** Audio files joined by one run of the concat demuxer. */
  audioBatch?: number;
};

/** The exit code, or -1 when the process could not be started at all. */
const ended = (child: ChildProcess) => new Promise<number | null>((resolve) => { child.once('close', (code) => resolve(code)); child.once('error', () => resolve(-1)); });
const write = (stream: Writable, data: Uint8Array) => new Promise<void>((resolve, reject) => { stream.write(data, (error) => (error ? reject(error) : resolve())); });

export async function streamingStitch(input: StitchInput): Promise<{ frames: number; streamed: boolean }> {
  const { dir, chunks, feed, fps } = input;
  const count = chunks.length;
  const sampleRate = input.sampleRate ?? 48000;
  if (!count) throw new Error('stitch: no chunks');
  if (!(input.framesPerChunk > 4)) throw new Error('stitch: chunks must be longer than 4 frames (Remotion joins AAC seamlessly only then)');
  if (Math.ceil(input.frames / input.framesPerChunk) !== count) throw new Error(`stitch: ${input.frames} frames in chunks of ${input.framesPerChunk} are ${Math.ceil(input.frames / input.framesPerChunk)} chunks, the task has ${count}`);
  const streamed = input.mode === 'fmp4' && Boolean(input.output);
  const outputPath = join(dir, input.outputName);

  const children = new Set<ChildProcess>();
  let failure: Error | null = null;
  const stop = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); for (const child of children) child.kill('SIGKILL'); };
  const track = (child: ChildProcess) => { children.add(child); child.once('close', () => children.delete(child)); child.once('error', stop); return child; };

  // One muxer for the whole job: video on fd 3, audio on fd 4.
  const muxer = track(input.ffmpeg([
    '-hide_banner', '-nostdin', '-f', 'mpegts', '-i', 'pipe:3', '-f', 'aac', '-i', 'pipe:4', '-c:v', 'copy', '-c:a', 'copy', '-r', String(fps),
    ...(input.mode === 'mp4'
      ? ['-movflags', 'faststart', '-metadata', input.comment, '-y', outputPath]
      // With an empty moov the header is written before the first packet arrives, so the ADTS to MP4 filter that FFmpeg
      // adds by itself for a normal MP4 has to be named.
      : ['-bsf:a', 'aac_adtstoasc', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-min_frag_duration', '4000000', '-metadata', input.comment, '-f', 'mp4', 'pipe:1']),
  ], ['ignore', input.mode === 'fmp4' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe']));
  const videoIn = muxer.stdio[3] as Writable;
  const audioIn = muxer.stdio[4] as Writable;
  let log = '';
  let muxed = 0;
  muxer.stderr!.on('data', (data: Buffer) => { const text = data.toString('utf8'); log = (log + text).slice(-3000); const frame = [...text.matchAll(/frame=\s*(\d+)/g)].pop(); if (frame) muxed = Number(frame[1]); });
  // A closed pipe means the muxer went away. Its exit code and log are the error worth reporting, not EPIPE.
  for (const stream of [videoIn, audioIn]) stream.on('error', () => undefined);
  const muxerEnded = ended(muxer);
  const leaving = input.mode !== 'fmp4' ? null : (input.output ? input.output.write(muxer.stdout as Readable) : pipeline(muxer.stdout as Readable, createWriteStream(outputPath))).catch(stop);

  // A chunk is released when both loops are done with it.
  const left = chunks.map(() => 2);
  const arrived = chunks.map(() => false);
  chunks.forEach((_, index) => { feed.ready(index).then(() => { arrived[index] = true; }, () => undefined); });
  const done = async (index: number) => { left[index]! -= 1; if (left[index] === 0) await feed.release(index); };

  const video = (async () => {
    for (let index = 0; index < count && !failure; index += 1) {
      await feed.ready(index);
      for await (const data of createReadStream(join(dir, chunks[index]!.video), { highWaterMark: 1 << 20 })) { if (failure) return; await write(videoIn, data as Buffer); }
      await done(index);
    }
    videoIn.end();
  })();
  const audio = (async () => {
    const chunkSeconds = input.framesPerChunk / fps;
    for (let first = 0; first < count && !failure;) {
      await feed.ready(first);
      // Everything that has arrived behind `first`, up to a batch: the join never waits for more than it needs.
      let last = first;
      while (last + 1 < count && last + 1 - first < (input.audioBatch ?? 256) && arrived[last + 1]) last += 1;
      const list = join(dir, `audio-list-${first}.txt`);
      await writeFile(list, Array.from({ length: last - first + 1 }, (_, offset) => { const index = first + offset; const cut = audioCut(index, count, chunkSeconds, sampleRate); return `file '${join(dir, chunks[index]!.audio).replaceAll("'", "'\\''")}'\ninpoint ${cut.inpoint}us\noutpoint ${cut.outpoint}us`; }).join('\n'));
      const concat = track(input.ffmpeg(['-hide_banner', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'copy', '-vn', '-f', 'adts', 'pipe:1'], ['ignore', 'pipe', 'pipe']));
      let concatLog = '';
      concat.stderr!.on('data', (data: Buffer) => { concatLog = (concatLog + data).slice(-1500); });
      const code = ended(concat);
      for await (const data of concat.stdout as Readable) { if (failure) return; await write(audioIn, data as Buffer); }
      if ((await code) !== 0) throw new Error(`audio join of chunks ${first} to ${last} failed: ${concatLog.slice(-600)}`);
      await rm(list, { force: true });
      for (let index = first; index <= last; index += 1) await done(index);
      first = last + 1;
    }
    audioIn.end();
  })();

  try {
    await Promise.all([video, audio]).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'ERR_STREAM_WRITE_AFTER_END') stop(new Error(`ffmpeg ended early (${await muxerEnded}): ${log.slice(-800)}`));
      else stop(error);
    });
    if (failure) throw failure;
    const code = await muxerEnded;
    await leaving;
    if (failure) throw failure;
    if (code !== 0) throw new Error(`ffmpeg ended with code ${code}: ${log.slice(-800)}`);
    if (muxed !== input.frames) throw new Error(`the joined video has ${muxed} frames, expected ${input.frames}`);
    return { frames: muxed, streamed };
  } catch (error) {
    stop(error);
    if (!streamed) await rm(outputPath, { force: true });
    throw failure ?? error;
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
}
