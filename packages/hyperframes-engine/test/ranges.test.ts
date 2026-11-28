/**
 * Split HyperFrames rendering without a browser: the range arithmetic, the checks before a join, heavy ranges from the
 * HTML, and the join itself on small synthetic chunks made by FFmpeg (needs ffmpeg and ffprobe on the PATH). Run: npm test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskRequest } from '../../core/src/types.ts';
import { audioPlan, checkChunks, distributedQuality, exactTicks, partsOf, segmentsFromHtml, tsOffsetSeconds, type ChunkMeta } from '../ranges.ts';
import { ensurePlan, planConfig, probeVideo, sizeFor, stitchSplit } from '../split.ts';

test('a chunk inside one slice is one part; across a slice boundary it is two; outside the plan it is refused', () => {
  const slices = [{ index: 0, startFrame: 0, endFrame: 3600 }, { index: 1, startFrame: 3600, endFrame: 5000 }];
  assert.deepEqual(partsOf(slices, 100, 400), [{ slice: 0, startFrame: 100, endFrame: 400 }]);
  assert.deepEqual(partsOf(slices, 3500, 3700), [{ slice: 0, startFrame: 3500, endFrame: 3600 }, { slice: 1, startFrame: 3600, endFrame: 3700 }]);
  assert.deepEqual(partsOf(slices, 3600, 5000), [{ slice: 1, startFrame: 3600, endFrame: 5000 }]);
  assert.throws(() => partsOf(slices, 4900, 5100), /not in HyperFrames' plan/);
  assert.throws(() => partsOf(slices, 10, 10), /empty/);
});

test('chunk timestamps: a chunk starts at its frame / fps, exact in 90 kHz ticks for the usual frame rates', () => {
  assert.equal(tsOffsetSeconds(450, 30), 15);
  assert.equal(tsOffsetSeconds(0, 30), 0);
  // 90 kHz ticks: frame n at 30 fps is n x 3000 ticks, so any chunk boundary falls on a tick.
  for (const fps of [24, 25, 30, 50, 60]) assert.ok(exactTicks(fps), `${fps} fps`);
  assert.ok(!exactTicks(7));
  for (const frame of [1, 449, 450, 1799]) assert.equal(Math.round(tsOffsetSeconds(frame, 30) * 90000), frame * 3000);
});

const meta = (startFrame: number, endFrame: number, extra: Partial<ChunkMeta> = {}): ChunkMeta => ({
  version: 1, planHash: 'p1', fps: 30, width: 1920, height: 1080, startFrame, endFrame, frames: endFrame - startFrame, gop: 60,
  parts: [{ slice: 0, startFrame, endFrame }], video: { name: `c${startFrame}.ts`, bytes: 1, sha256: 'x' }, ...extra,
});
const job = { startFrame: 0, endFrame: 300, planHash: 'p1', fps: 30, width: 1920, height: 1080 };

test('before the join: chunks of any length that meet end to end pass; a gap, an overlap, a short chunk or another plan does not', () => {
  assert.deepEqual(checkChunks([meta(0, 120), meta(120, 150), meta(150, 300)], job), []);
  assert.match(checkChunks([meta(0, 120), meta(130, 300)], job).join(), /starts at frame 130, expected 120/);
  assert.match(checkChunks([meta(0, 120), meta(100, 300)], job).join(), /starts at frame 100/);
  assert.match(checkChunks([meta(0, 120), meta(120, 290)], job).join(), /end at frame 290/);
  assert.match(checkChunks([meta(0, 120, { frames: 119 }), meta(120, 300)], job).join(), /119 frames instead of 120/);
  assert.match(checkChunks([meta(0, 120), meta(120, 300, { planHash: 'p2' })], job).join(), /another plan/);
  assert.match(checkChunks([meta(0, 120), meta(120, 300, { width: 1280, height: 720 })], job).join(), /1280x720/);
  assert.deepEqual(checkChunks([], job), ['no chunks']);
});

test('sound: none, the whole track copied, or a range cut on the sample', () => {
  assert.deepEqual(audioPlan({ hasAudio: false, startFrame: 0, endFrame: 300, fps: 30 }), { mode: 'none', startSeconds: 0, seconds: 10 });
  assert.deepEqual(audioPlan({ hasAudio: true, startFrame: 0, endFrame: 300, fps: 30 }), { mode: 'copy', startSeconds: 0, seconds: 10 });
  assert.deepEqual(audioPlan({ hasAudio: true, startFrame: 45, endFrame: 201, fps: 30 }), { mode: 'cut', startSeconds: 1.5, seconds: 5.2 });
});

test('heavy ranges from the HTML: data-render-cost, a canvas clip, nothing else', () => {
  const html = `
    <div id="root" data-composition-id="main" data-start="0" data-duration="60" data-width="1920" data-height="1080">
      <div class="clip" data-start="0" data-duration="20">light</div>
      <div class="clip" data-start="20" data-duration="10" data-render-cost="heavy"><canvas></canvas></div>
      <canvas class="clip" data-start="45.5" data-duration="2"></canvas>
      <div class="clip" data-render-cost="gl" data-duration="5" data-start="50"></div>
      <canvas id="not-a-clip"></canvas>
    </div>`;
  assert.deepEqual(segmentsFromHtml(html, 30, 1800), [
    { startFrame: 600, endFrame: 900, cls: 'heavy' },
    { startFrame: 1365, endFrame: 1425, cls: 'heavy' },
    { startFrame: 1500, endFrame: 1650, cls: 'gl' },
  ]);
  assert.deepEqual(segmentsFromHtml('<canvas class="clip" data-start="55" data-duration="10"></canvas>', 30, 1800), [{ startFrame: 1650, endFrame: 1800, cls: 'heavy' }]);
});

test('qualities, sizes and the plan configuration every instance must agree on', () => {
  assert.deepEqual(distributedQuality('draft'), { quality: 'draft' });
  assert.deepEqual(distributedQuality(undefined), { quality: 'standard', crf: 16 });
  assert.deepEqual(distributedQuality('delivery'), { quality: 'high' });
  assert.deepEqual(sizeFor(1920, 1080, undefined), { width: 1920, height: 1080, downscale: false, bitrate: 10_000_000 });
  assert.deepEqual(sizeFor(1920, 1080, '480p'), { width: 854, height: 480, downscale: true, bitrate: 2_500_000 });
  assert.equal(sizeFor(1920, 1080, '4k').outputResolution, 'landscape-4k');
  assert.equal(sizeFor(1080, 1920, '1440p').outputResolution, 'portrait-1440p');
  const config = planConfig({ fps: 30, width: 1920, height: 1080 }, { quality: 'draft', variables: { title: 'x' } });
  assert.equal(config.chunkSize, 3600);
  assert.equal(config.keyframeIntervalSeconds, 2);
  assert.deepEqual(config.variables, { title: 'x' });
  assert.deepEqual(planConfig({ fps: 30, width: 1920, height: 1080 }, { quality: 'draft' }), planConfig({ fps: 30, width: 1920, height: 1080 }, { quality: 'draft' }));
});

// ---- The join on real (small) MPEG-TS chunks, with a stand-in for HyperFrames' planner ----

const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
const fps = 30;
const total = 90;

/** A stand-in for @hyperframes/producer/distributed: one slice, a sine as the mixed audio, a fixed plan hash. */
function fakeApi(planHash = 'plan-hash-1') {
  const calls = { plans: 0 };
  return {
    calls,
    api: {
      async planV2(_project: string, _config: Record<string, unknown>, planDir: string) {
        calls.plans += 1;
        await new Promise((done) => setTimeout(done, 200));
        mkdirSync(planDir, { recursive: true });
        writeFileSync(join(planDir, 'plan.json'), '{}');
        return { planHash: 'v2', sourcePlanV1Hash: planHash, chunkCount: 1, totalFrames: total, fps, width: 320, height: 180, producerVersion: 'test' };
      },
      async renderChunkV2(): Promise<never> { throw new Error('not used'); },
      materializePlanV2Target(_planDir: string, _target: unknown, destination: string) {
        mkdirSync(join(destination, 'meta'), { recursive: true });
        writeFileSync(join(destination, 'meta', 'chunks.json'), JSON.stringify([{ index: 0, startFrame: 0, endFrame: total }]));
        ffmpeg('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${total / fps}`, '-c:a', 'aac', join(destination, 'audio.m4a'));
        return { planDir: destination, audioPath: join(destination, 'audio.m4a'), sourcePlanV1Hash: planHash };
      },
    },
  };
}

/** A chunk as renderSplitChunk() leaves it: H.264 in MPEG-TS at its place on the timeline, closed GOP, and its description. */
function makeChunk(dir: string, base: string, startFrame: number, endFrame: number, planHash = 'plan-hash-1'): TaskRequest['chunks'] extends (infer T)[] | undefined ? T : never {
  const frames = endFrame - startFrame;
  const video = join(dir, `${base}.ts`);
  ffmpeg('-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${fps}`, '-vf', `trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS`, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-flags', '+cgop', '-output_ts_offset', String(startFrame / fps), '-f', 'mpegts', video);
  const sha256 = createHash('sha256').update(readFileSync(video)).digest('hex');
  const description: ChunkMeta = { version: 1, planHash, fps, width: 320, height: 180, startFrame, endFrame, frames, gop: 60, parts: [{ slice: 0, startFrame, endFrame }], video: { name: `${base}.ts`, bytes: statSync(video).size, sha256 } };
  writeFileSync(join(dir, `${base}.json`), JSON.stringify(description));
  return { index: 0, files: [{ name: `${base}.ts`, bytes: 0, sha256: '' }, { name: `${base}.json`, bytes: 0, sha256: '' }], startFrame, endFrame };
}

const stitchTask = (chunks: NonNullable<TaskRequest['chunks']>, extra: Partial<TaskRequest> = {}): TaskRequest => ({
  id: 'job-stitch', jobId: 'job', kind: 'stitch', render: {}, plan: { fps, durationInFrames: total, width: 320, height: 180, chunkable: true },
  startFrame: 0, endFrame: total, chunks: chunks.map((chunk, index) => ({ ...chunk, index })), stitch: 'combine', ...extra,
});

test('the join: chunks of different lengths become one MP4 with every frame, the right duration and one audio track', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-stitch-'));
  try {
    const { api, calls } = fakeApi();
    const chunks = [makeChunk(dir, 'chunk-0000-r1', 0, 40), makeChunk(dir, 'chunk-0001-r2', 40, 47), makeChunk(dir, 'chunk-0002-r1', 47, 90)];
    const [out] = await stitchSplit({ api, task: stitchTask(chunks), dir, projectDir: dir, composition: { fps, width: 320, height: 180 }, options: {} });
    const probed = await probeVideo(join(dir, out!));
    assert.equal(probed.frames, 90);
    assert.ok(Math.abs(probed.seconds - 3) < 1e-6, `video lasts ${probed.seconds}`);
    const audio = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', join(dir, out!)], { encoding: 'utf8' }).trim());
    assert.ok(Math.abs(audio - 3) < 0.03, `audio lasts ${audio}`);
    assert.equal(calls.plans, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the join refuses a damaged chunk, a gap and a chunk from another plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-stitch-'));
  try {
    const { api } = fakeApi();
    const composition = { fps, width: 320, height: 180 };
    const good = [makeChunk(dir, 'a', 0, 45), makeChunk(dir, 'b', 45, 90)];
    // damaged: the bytes no longer match the hash written where it was rendered
    const bytes = readFileSync(join(dir, 'b.ts'));
    bytes[bytes.length - 100] ^= 0xff;
    writeFileSync(join(dir, 'b.ts'), bytes);
    await assert.rejects(stitchSplit({ api, task: stitchTask(good), dir, projectDir: dir, composition, options: {} }), /hash differs/);
    // a gap: frames 45-50 are missing
    const gap = [makeChunk(dir, 'c', 0, 45), makeChunk(dir, 'd', 50, 90)];
    await assert.rejects(stitchSplit({ api, task: stitchTask(gap), dir, projectDir: dir, composition, options: {} }), /starts at frame 50, expected 45/);
    // another plan: an instance saw a different project
    const other = [makeChunk(dir, 'e', 0, 45), makeChunk(dir, 'f', 45, 90, 'plan-hash-2')];
    await assert.rejects(stitchSplit({ api, task: stitchTask(other), dir, projectDir: dir, composition, options: {} }), /another plan/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the plan is made once per instance and job, also when several processes ask at the same time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-plan-'));
  try {
    const { api, calls } = fakeApi();
    const config = planConfig({ fps, width: 320, height: 180 }, {});
    const plans = await Promise.all([1, 2, 3].map(() => ensurePlan(api, { jobDir: dir, projectDir: dir, config })));
    assert.equal(calls.plans, 1);
    assert.ok(plans.every((plan) => plan.planHash === 'plan-hash-1' && plan.totalFrames === total && plan.slices.length === 1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
