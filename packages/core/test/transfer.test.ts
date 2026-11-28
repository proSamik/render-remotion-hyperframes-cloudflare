/**
 * Verified transfers, the chunk feed of the streaming join, the range proxy and the planner. A small S3 in memory
 * (fake-s3.ts) stands in for the bucket and for the Worker's R2 gateway.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChunkFeed } from '../src/chunk-feed.ts';
import { EXAMPLE_RATES, planFleet, TIERS, toFleetOptions } from '../src/planner.ts';
import { startRangeProxy } from '../src/range-proxy.ts';
import { downloadVerified, hashFile, putFile, putStream, TransferError } from '../src/transfer.ts';
import type { FileInfo } from '../src/types.ts';
import { startFakeS3 } from './fake-s3.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scratch = () => mkdtemp(join(tmpdir(), 'rrh-transfer-'));
/** fetch() that sends the gateway host of the containers to the fake store. */
const viaGateway = (endpoint: string): typeof fetch => (input, init) => fetch(String(input).replace('http://r2.internal/', `${endpoint}/`), init);

test('a download with the right length and wrong bytes is not accepted: it is repeated, and no file appears before it is verified', async () => {
  const store = await startFakeS3();
  const dir = await scratch();
  try {
    const bytes = randomBytes(300_000);
    store.objects.set('chunk.ts', { body: bytes, etag: 'x' });
    const url = `${store.endpoint}/bucket/chunk.ts?X-Amz-Signature=secret-part-of-the-url`;
    const path = join(dir, 'chunk.ts');
    store.state.corruptNextGet = 1;
    const got = await downloadVerified(url, path, { bytes: bytes.length, sha256: sha256(bytes) });
    assert.equal(got.sha256, sha256(bytes));
    assert.equal(store.log.filter((entry) => entry.method === 'GET').length, 2);
    assert.ok((await readFile(path)).equals(bytes));
    // damaged every time: the error says so, the file is not there, and the URL's query is not in the message
    store.state.corruptNextGet = 99;
    const failed = await downloadVerified(url, join(dir, 'other.ts'), { bytes: bytes.length, sha256: sha256(bytes) }, { attempts: 2 }).catch((error) => error);
    assert.ok(failed instanceof TransferError && failed.code === 'checksum_mismatch');
    assert.doesNotMatch(failed.message, /secret-part/);
    assert.deepEqual(await readdir(dir), ['chunk.ts']);
    // an answer that cannot get better (a refused or expired URL) is not asked for again
    const before = store.log.length;
    await assert.rejects(downloadVerified(`${store.endpoint}/bucket/missing`, join(dir, 'missing'), {}), /404/);
    assert.equal(store.log.length, before + 1);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an upload over a presigned URL is checked against the ETag; through the gateway the SHA-256 travels with it', async () => {
  const store = await startFakeS3();
  const gateway = await startFakeS3({ gateway: true });
  const dir = await scratch();
  try {
    const bytes = randomBytes(200_000);
    const path = join(dir, 'chunk-0000-r1.ts');
    await writeFile(path, bytes);
    const file = await hashFile(path);
    assert.deepEqual({ bytes: file.bytes, sha256: file.sha256, md5: file.md5 }, { bytes: bytes.length, sha256: sha256(bytes), md5: createHash('md5').update(bytes).digest('hex') });
    await putFile(`${store.endpoint}/bucket/renders/r1/chunk-0000-r1.ts`, path, file);
    assert.ok(store.objects.get('renders/r1/chunk-0000-r1.ts')!.body.equals(bytes));
    // a store that answers another ETag than the MD5 of what was sent: refused after the retries
    await assert.rejects(putFile(`${store.endpoint}/bucket/x`, path, { ...file, md5: '0'.repeat(32) }, { attempts: 2 }), (error: TransferError) => error.code === 'checksum_mismatch');
    await putFile('http://r2.internal/renders/r1/chunk-0000-r1.ts', path, file, { fetch: viaGateway(gateway.endpoint) });
    assert.ok(gateway.objects.get('renders/r1/chunk-0000-r1.ts')!.body.equals(bytes));
    // the gateway (R2 with a checksum) refuses bytes that do not have the SHA-256 that was announced
    await assert.rejects(putFile('http://r2.internal/renders/r1/bad', path, { ...file, sha256: 'f'.repeat(64) }, { fetch: viaGateway(gateway.endpoint), attempts: 1 }), /400/);
  } finally { await store.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a stream of unknown length is uploaded in equal parts while it is produced', async () => {
  const gateway = await startFakeS3({ gateway: true });
  try {
    const part = 5 * 1024 * 1024;
    const pieces = Array.from({ length: 23 }, () => randomBytes(700_001)); // 16.1 MB in odd pieces
    const whole = Buffer.concat(pieces);
    const result = await putStream('http://r2.internal/renders/r1/output', (async function* () { yield* pieces; })(), 'out.mp4', { fetch: viaGateway(gateway.endpoint), partBytes: part, parallel: 2 });
    assert.deepEqual(result, { name: 'out.mp4', bytes: whole.length, sha256: sha256(whole) });
    assert.ok(gateway.objects.get('renders/r1/output')!.body.equals(whole));
    const parts = gateway.log.filter((entry) => entry.method === 'PUT').map((entry) => entry.bytes);
    assert.deepEqual(parts.slice().sort((a, b) => b - a), [part, part, part, whole.length - 3 * part]);
    await assert.rejects(putStream('https://store.example/presigned', (async function* () { yield Buffer.alloc(1); })(), 'out.mp4'), /gateway/);
  } finally { await gateway.close(); }
});

test('the chunk feed fetches ahead inside a window, hands chunks over verified and in order, and deletes behind the reader', async () => {
  const store = await startFakeS3();
  const dir = await scratch();
  try {
    const count = 12;
    const size = 100_000;
    const chunks = Array.from({ length: count }, (_, index) => {
      const files: (FileInfo & { url: string })[] = ['ts', 'aac'].map((extension) => { const body = randomBytes(size); const name = `chunk-${String(index).padStart(4, '0')}-r1.${extension}`; store.objects.set(name, { body, etag: 'x' }); return { name, bytes: size, sha256: sha256(body), url: `${store.endpoint}/bucket/${name}` }; });
      return { index, files };
    });
    // a window of 3 chunks: whatever the parallelism, at most that much is on the disk
    const feed = createChunkFeed({ dir, chunks, parallel: 8, windowBytes: 3 * 2 * size });
    store.state.corruptNextGet = 1; // one damaged download on the way: repeated, never handed over
    for (let index = 0; index < count; index += 1) {
      await feed.ready(index);
      for (const file of chunks[index]!.files) assert.equal(sha256(await readFile(join(dir, file.name))), file.sha256);
      assert.ok(!existsSync(join(dir, chunks[Math.min(count - 1, index + 5)]!.files[0]!.name)) || index + 5 >= count, 'a chunk far ahead is already on the disk');
      await feed.release(index);
      assert.ok(!existsSync(join(dir, chunks[index]!.files[0]!.name)), 'a released chunk is still on the disk');
    }
    const stats = feed.stats();
    assert.equal(stats.fetched, count);
    assert.equal(stats.diskNow, 0);
    assert.ok(stats.diskPeak <= 4 * 2 * size, `disk peak ${stats.diskPeak} with a window of ${3 * 2 * size}`);
    assert.deepEqual(await readdir(dir), []);
    // a chunk that never matches its hash stops the feed with a checksum error
    store.state.corruptNextGet = 99;
    const broken = createChunkFeed({ dir, chunks: chunks.slice(0, 2), parallel: 1 });
    const error = await broken.ready(0).catch((failure) => failure);
    assert.equal(error.code, 'checksum_mismatch');
    // files without a URL are already there: checked for their size, never deleted
    store.state.corruptNextGet = 0;
    await writeFile(join(dir, 'local.ts'), Buffer.alloc(10));
    const local = createChunkFeed({ dir, chunks: [{ index: 0, files: [{ name: 'local.ts', bytes: 10, sha256: 'unused' }] }] });
    await local.ready(0);
    await local.release(0);
    assert.ok(existsSync(join(dir, 'local.ts')));
    await assert.rejects(createChunkFeed({ dir, chunks: [{ index: 0, files: [{ name: 'local.ts', bytes: 11, sha256: 'unused' }] }] }).ready(0), /expected 11/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the range proxy fetches only the blocks a reader asks for, once, and refuses a file that changed size', async () => {
  const store = await startFakeS3();
  const bytes = randomBytes(8 * 1024 * 1024);
  store.objects.set('recording.mp4', { body: bytes, etag: 'x' });
  const proxy = await startRangeProxy({ 'media/recording.mp4': { url: `${store.endpoint}/bucket/recording.mp4`, size: bytes.length, contentType: 'video/mp4' }, 'wrong.mp4': { url: `${store.endpoint}/bucket/recording.mp4`, size: bytes.length + 1 } }, { blockBytes: 256 * 1024, readAheadBlocks: 2 });
  try {
    const url = proxy.urlFor('media/recording.mp4');
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/media\/recording\.mp4$/);
    const range = async (from: number, to: number) => { const response = await fetch(url, { headers: { range: `bytes=${from}-${to}` } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${from}-${to}/${bytes.length}`); return Buffer.from(await response.arrayBuffer()); };
    // what a player does: the index at the end, then samples somewhere in the middle, twice (picture and sound)
    assert.ok((await range(bytes.length - 1000, bytes.length - 1)).equals(bytes.subarray(bytes.length - 1000)));
    assert.ok((await range(4_000_000, 4_300_000)).equals(bytes.subarray(4_000_000, 4_300_001)));
    assert.ok((await range(4_100_000, 4_200_000)).equals(bytes.subarray(4_100_000, 4_200_001)));
    const stats = proxy.stats();
    assert.ok(stats.upstreamBytes < bytes.length / 8, `${stats.upstreamBytes} bytes fetched of ${bytes.length}`);
    assert.ok(stats.cacheHits >= 1);
    assert.equal(stats.perFile['media/recording.mp4']!.upstreamBytes, stats.upstreamBytes);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal(proxy.stats().upstreamBytes, stats.upstreamBytes, 'a HEAD request fetched bytes');
    assert.equal((await fetch(url, { headers: { range: `bytes=${bytes.length}-` } })).status, 416);
    assert.equal((await fetch(proxy.urlFor('nothing.mp4'))).status, 404);
    await assert.rejects(fetch(proxy.urlFor('wrong.mp4'), { headers: { range: 'bytes=0-10' } }).then((response) => response.arrayBuffer()));
  } finally { await proxy.close(); await store.close(); }
});

test('the planner: a tier is a finish time and chunk bounds; the fleet follows from the content', () => {
  const hour = { fps: 30, frames: 108_000 };
  const standard = planFleet(hour, TIERS.standard);
  assert.equal(standard.targetSeconds, 216); // 6 % of an hour
  assert.equal(standard.framesPerChunk % 30, 0);
  assert.ok(standard.chunkSeconds >= 6 && standard.chunkSeconds <= 10);
  const saver = planFleet(hour, TIERS.saver);
  assert.ok(saver.instances < standard.instances && saver.chunkSeconds >= 20);
  // heavy content: shorter chunks so that one heavy chunk fits the target, and one instance per heavy process
  const heavy = planFleet({ ...hour, segments: [{ startFrame: 30_000, endFrame: 36_000, cls: 'heavy' }] }, TIERS.standard);
  assert.ok(heavy.chunks.heavy > 0 && heavy.instances > standard.instances);
  // a short clip: the floor decides, one instance is enough, and never more processes than chunks
  const clip = planFleet({ fps: 30, frames: 300 }, TIERS.fast);
  assert.equal(clip.targetSeconds, 90);
  assert.equal(clip.instances, 1);
  // the caller's limit bounds the fleet and the plan says so
  const bounded = planFleet(hour, TIERS.fast, EXAMPLE_RATES, { maxInstances: 4 });
  assert.deepEqual({ instances: bounded.instances, bounded: bounded.bounded }, { instances: 4, bounded: true });
  assert.deepEqual(toFleetOptions(bounded), { instances: 4, framesPerChunk: bounded.framesPerChunk, processesPerInstance: 2 });
});
