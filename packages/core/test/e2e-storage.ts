/**
 * A whole render in storage mode without Cloudflare: local task servers, and a small S3 in memory in place of R2.
 * It exercises what the unit tests cannot: the real engine writing per-run files, uploads with their checks, the join
 * fetching the chunks of the runs that won, and the output arriving in the store.
 *
 *   cd examples/remotion-only && npm run site
 *   node ../../packages/core/bin/with-typescript-run.mjs ../../packages/core/test/e2e-storage.ts <gateway|presigned> <combine|stream|stream-fmp4> <out.mp4>
 *
 * gateway    the protocol of the Worker's R2 gateway (plain URLs, SHA-256 header, JSON multipart)
 * presigned  real presigned URLs from s3-presign.ts through the policy of signer.ts, single PUTs checked by ETag
 * Not a test of R2 itself: the store is fake-s3.ts.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJob, progressOf, step } from '../src/coordinator.ts';
import { createLocalFleet } from '../src/local.ts';
import { createPresigner } from '../src/s3-presign.ts';
import type { Storage, StitchMode } from '../src/types.ts';
import { startFakeS3 } from './fake-s3.ts';

const [mode, stitch, out] = process.argv.slice(3) as ['gateway' | 'presigned', StitchMode, string];
if (!['gateway', 'presigned'].includes(mode) || !out) { console.error('Usage: e2e-storage.ts <gateway|presigned> <combine|stream|stream-fmp4> <out.mp4>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const store = await startFakeS3({ gateway: mode === 'gateway' });
const presigner = createPresigner({ endpoint: store.endpoint, bucket: 'renders-bucket', accessKeyId: 'TESTKEYID', secretAccessKey: 'test-secret-not-a-real-one' });
const storage: Storage = mode === 'gateway'
  ? { presignPut: async (key) => `${store.endpoint}/${key}`, presignGet: async (key) => `${store.endpoint}/${key}` }
  : { presignPut: (key) => presigner.presign('PUT', key, {}, 3600), presignGet: (key) => presigner.presign('GET', key, {}, 3600) };
const fleet = createLocalFleet({
  workDir: resolve('.render-work-e2e'), engine: join(here, '../../cloudflare-containers/container/engine.ts'),
  // a low multipart threshold, so that the parts protocol runs with small files too
  env: { REMOTION_SITES_DIR: resolve('build/sites'), REMOTION_PROJECT_DIR: resolve('.'), RENDER_MULTIPART_ABOVE_MIB: '5', ...(mode === 'gateway' ? { RENDER_GATEWAY_URL: `${store.endpoint}/` } : {}) },
});
const job = createJob(`e2e${Date.now().toString(36)}`, { render: { composition: 'Shapes', frameRange: [0, 89], scale: 0.25 }, fleet: { instances: 2, processesPerInstance: 1, framesPerChunk: 30, stitch } });
try {
  while (job.phase !== 'done' && job.phase !== 'failed') { await step(job, fleet, storage); if (fleet.startError) throw fleet.startError; await new Promise((done) => setTimeout(done, 500)); }
  const progress = progressOf(job);
  if ((job.phase as string) === 'failed' || !job.output?.key) throw new Error(`render failed:\n${job.errors.map((error) => `  ${error.message}`).join('\n')}`);
  const object = store.objects.get(job.output.key);
  if (!object) throw new Error(`the output object ${job.output.key} is not in the store`);
  if (createHash('sha256').update(object.body).digest('hex') !== job.output.sha256) throw new Error('the output in the store does not have the recorded SHA-256');
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(resolve(out), object.body);
  const keys = [...store.objects.keys()].sort();
  console.log(JSON.stringify({ mode, stitch, out: resolve(out), bytes: object.body.length, frames: progress.frames, chunks: progress.chunks.total, instancesLeft: progress.instances, objects: keys, multipartCalls: store.log.filter((entry) => entry.query.includes('uploadId')).length, errors: job.errors.map((error) => error.message) }, null, 2));
} finally { await fleet.close(); await store.close(); }
