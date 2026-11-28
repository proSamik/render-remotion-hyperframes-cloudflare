/**
 * Presigned URLs, the signing policy and the resumable multipart upload, against a small S3 in memory (fake-s3.ts).
 * Nothing here talks to a real bucket.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AwsClient } from 'aws4fetch';
import { compositeEtag, planParts, uploadMultipart, type MultipartCall } from '../src/multipart.ts';
import { createPresigner } from '../src/s3-presign.ts';
import { createSigner, keys, refusal, SignerRefusal } from '../src/signer.ts';
import { startFakeS3 } from './fake-s3.ts';

const credentials = { accessKeyId: 'TESTKEYID', secretAccessKey: 'test-secret-not-a-real-one' };
const user = 'user-one';
const job = 'job-0001';
const sha = 'a'.repeat(64);

test('the presigner signs like a known SigV4 implementation (aws4fetch), for objects, odd keys and multipart queries', async () => {
  const at = Date.UTC(2026, 10, 28, 12, 0, 0);
  const presigner = createPresigner({ endpoint: 'https://account.example-store.test', bucket: 'renders', ...credentials, now: () => at });
  const reference = new AwsClient({ ...credentials, service: 's3', region: 'auto' });
  const cases: [Parameters<typeof presigner.presign>[0], string, Record<string, string>][] = [
    ['GET', 'jobs/user-one/job-0001/output.mp4', {}],
    ['PUT', "inputs/user-one/a file (1)!'*.mov", {}],
    ['PUT', keys.output(user, job), { uploadId: 'abc+/=~def', partNumber: '7' }],
    ['POST', keys.output(user, job), { uploads: '' }],
    ['GET', '', { uploads: '', prefix: keys.input(user, sha), 'max-uploads': '1000' }],
  ];
  for (const [method, key, query] of cases) {
    const ours = new URL(await presigner.presign(method, key, query, 900));
    const target = new URL(`${ours.origin}${ours.pathname}`);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    target.searchParams.set('X-Amz-Expires', '900');
    const theirs = new URL((await reference.sign(new Request(target, { method }), { aws: { signQuery: true, datetime: '20261128T120000Z', allHeaders: false } })).url);
    assert.equal(ours.searchParams.get('X-Amz-Signature'), theirs.searchParams.get('X-Amz-Signature'), `${method} ${key} ${JSON.stringify(query)}`);
    assert.equal(ours.searchParams.get('X-Amz-Credential'), theirs.searchParams.get('X-Amz-Credential'));
  }
});

test('the signer signs only what the scope allows: one user, one job, the listed calls, six hours', async () => {
  const scope = { user, job };
  const allowed = [
    { method: 'GET', key: keys.input(user, sha) }, { method: 'PUT', key: keys.input(user, sha) }, { method: 'HEAD', key: keys.output(user, job) },
    { method: 'PUT', key: keys.chunk(user, job, 12, 2, 'ts') }, { method: 'GET', key: keys.chunk(user, job, 12, 2, 'aac') },
    { method: 'POST', key: keys.output(user, job), query: { uploads: '' } }, { method: 'PUT', key: keys.output(user, job), query: { uploadId: 'id-1', partNumber: 10000 } },
    { method: 'POST', key: keys.input(user, sha), query: { uploadId: 'id-1' } }, { method: 'GET', key: keys.input(user, sha), query: { uploadId: 'id-1', 'max-parts': '1000' } },
    { method: 'GET', key: '', query: { uploads: '', prefix: keys.input(user, sha) } },
  ] as const;
  for (const request of allowed) assert.equal(refusal(scope, request), null, JSON.stringify(request));
  const refused = [
    { method: 'GET', key: keys.input('user-two', sha) },                                  // another user's input
    { method: 'GET', key: keys.output(user, 'job-0002') },                                // another job
    { method: 'GET', key: `jobs/${user}/${job}/../job-0002/output.mp4` },                 // traversal
    { method: 'GET', key: `inputs/${user}/not-a-hash` },
    { method: 'DELETE', key: keys.output(user, job) },                                    // no delete without a cleanup scope
    { method: 'PUT', key: keys.output(user, job), query: { uploadId: 'id-1', partNumber: 10001 } },
    { method: 'PUT', key: keys.chunk(user, job, 1, 1), query: { uploadId: 'id-1', partNumber: 1 } },
    { method: 'GET', key: '', query: { uploads: '', prefix: `inputs/${user}/` } },         // listing a whole prefix
    { method: 'GET', key: '', query: { 'list-type': '2', prefix: keys.jobPrefix(user, job) } },
    { method: 'GET', key: keys.output(user, job), query: { versionId: 'x' } },
    { method: 'GET', key: keys.output(user, job), expiresInSeconds: 7 * 3600 },
  ] as const;
  for (const request of refused) assert.notEqual(refusal(scope, request), null, JSON.stringify(request));
  assert.notEqual(refusal({ user: '../x', job }, { method: 'GET', key: 'inputs/../x/y' }), null);
  // a cleanup scope may delete and list its own job, never the inputs
  const cleanup = { user, job, cleanup: true };
  assert.equal(refusal(cleanup, { method: 'DELETE', key: keys.chunk(user, job, 0, 1) }), null);
  assert.equal(refusal(cleanup, { method: 'GET', key: '', query: { 'list-type': '2', prefix: keys.jobPrefix(user, job) } }), null);
  assert.notEqual(refusal(cleanup, { method: 'DELETE', key: keys.input(user, sha) }), null);
  const signer = createSigner(createPresigner({ endpoint: 'https://account.example-store.test', bucket: 'renders', ...credentials }));
  await assert.rejects(signer.sign(scope, { method: 'GET', key: keys.output('user-two', job) }), SignerRefusal);
  assert.match(await signer.sign(scope, { method: 'GET', key: keys.output(user, job) }), /\/renders\/jobs\/user-one\/job-0001\/output\.mp4\?/);
});

test('planParts: equal parts of at least 5 MiB, never more than 10,000; compositeEtag is S3\'s rule', () => {
  assert.deepEqual(planParts(1), { partSize: 32 * 1024 * 1024, count: 1 });
  assert.deepEqual(planParts(100 * 1024 * 1024, 1), { partSize: 5 * 1024 * 1024, count: 20 });
  const huge = planParts(2 ** 40);
  assert.ok(huge.count <= 10_000 && huge.partSize * huge.count >= 2 ** 40);
  const parts = [Buffer.from('first part'), Buffer.from('second part')];
  const md5s = parts.map((part) => createHash('md5').update(part).digest('hex'));
  assert.equal(compositeEtag(md5s), `${createHash('md5').update(Buffer.concat(md5s.map((md5) => Buffer.from(md5, 'hex')))).digest('hex')}-2`);
});

test('a multipart upload that breaks is resumed from what the store has: no local state, only the missing parts are sent', async () => {
  const store = await startFakeS3();
  const dir = await mkdtemp(join(tmpdir(), 'rrh-multipart-'));
  try {
    const part = 5 * 1024 * 1024;
    const bytes = randomBytes(part * 4 + 12345); // 5 parts
    const path = join(dir, 'input.mov');
    await writeFile(path, bytes);
    const key = keys.input(user, createHash('sha256').update(bytes).digest('hex'));
    const presigner = createPresigner({ endpoint: store.endpoint, bucket: 'renders', ...credentials });
    const signer = createSigner(presigner);
    // every call goes through the policy: the upload needs nothing the scope does not allow
    const sign = (call: MultipartCall) => signer.sign({ user, job }, { method: call.method, key: call.key, query: call.query });

    // First try: the connection breaks on every part after the second one that arrives.
    let arrived = 0;
    store.state.intercept = ({ method, query }) => { if (method === 'PUT' && query.has('partNumber')) { arrived += 1; if (arrived > 2) return 'drop'; } };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    await assert.rejects(uploadMultipart({ path, key, sign, partSize: part, parallel: 1, signal: controller.signal }));
    assert.equal(store.objects.size, 0);
    assert.equal([...store.uploads.values()][0]!.parts.size, 2);

    // Second try, as a new process would do it: it finds the upload and its two parts in the store.
    store.state.intercept = null;
    const before = store.log.length;
    const result = await uploadMultipart({ path, key, sign, partSize: part });
    assert.equal(result.parts, 5);
    assert.equal(result.partsResumed, 2);
    assert.equal(result.bytesSent, bytes.length - 2 * part);
    assert.equal(store.log.slice(before).filter((entry) => entry.method === 'PUT').length, 3);
    assert.ok(store.objects.get(key)!.body.equals(bytes));
    assert.equal(result.etag, store.objects.get(key)!.etag);
    assert.equal(store.uploads.size, 0);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a resumed part whose bytes are not the local bytes is sent again', async () => {
  const store = await startFakeS3();
  const dir = await mkdtemp(join(tmpdir(), 'rrh-multipart-'));
  try {
    const part = 5 * 1024 * 1024;
    const path = join(dir, 'input.mov');
    const first = randomBytes(part * 2);
    await writeFile(path, first);
    const key = keys.input(user, sha);
    const sign = async (call: MultipartCall) => `${store.endpoint}/renders/${call.key}?${new URLSearchParams(call.query)}`;
    let arrived = 0;
    store.state.intercept = ({ method, query }) => { if (method === 'PUT' && query.has('partNumber')) { arrived += 1; if (arrived > 1) return 'drop'; } };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);
    await assert.rejects(uploadMultipart({ path, key, sign, partSize: part, parallel: 1, signal: controller.signal }));
    store.state.intercept = null;
    // the file changed between the two tries: part 1 in the store is stale
    const second = Buffer.concat([randomBytes(part), first.subarray(part)]);
    await writeFile(path, second);
    const result = await uploadMultipart({ path, key, sign, partSize: part });
    assert.equal(result.partsResumed, 0);
    assert.ok(store.objects.get(key)!.body.equals(second));
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
