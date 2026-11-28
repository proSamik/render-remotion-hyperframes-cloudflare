/**
 * The render service on Cloudflare: one Worker, two Durable Object classes.
 *
 *   Worker            checks the secret, routes /renders
 *   RenderJob         one per render: holds the job state and runs the coordinator from an alarm every 1.5 s
 *   RenderContainer   one per container instance: starts the container (ctx.container) and forwards HTTP to it
 *   R2Gateway         optional: lets a container read and write its own job's objects in R2 without credentials
 *
 * The containers never hold a key. With a bucket they reach R2 through R2Gateway (default), or, with R2_DIRECT, over
 * presigned URLs that the coordinator signs for exactly the objects a task needs.
 *
 * Written against the Durable Object Container API (`ctx.container`, scheduling_policy "durable_object"), which
 * replaced the `Container` class of `@cloudflare/containers` in the Cloudflare docs in November 2026.
 *
 * HTTP API (every request needs `Authorization: Bearer <RENDER_SECRET>`, except the signed links). docs/api.md,
 * docs/openapi.yaml:
 *   GET    /health                    -> { ok, service, storage, instanceType, maxInstancesPerRender }
 *   PUT    /uploads/<file name>       -> stores an input file in R2: { uploadId, name, bytes, url } (url: signed, 7 days)
 *   DELETE /uploads/<uploadId>        -> deletes it
 *   POST   /renders  { render, fleet } or the short form { engine, composition, ... } (../src/api-request.ts)
 *                                     -> { renderId }
 *   GET    /renders/<id>              -> progress (see RenderProgress in ../src/types.ts)
 *   GET    /renders/<id>/output       -> the file; with ?presign=<seconds> a time-limited R2 URL as { url }
 *   GET    /renders/<id>/link?expires=<seconds> -> { url }: a download link that needs no secret
 *   POST   /renders/<id>/cancel       -> stops the instances, keeps the state (phase "failed", kind job_cancelled)
 *   DELETE /renders/<id>              -> stops the instances, deletes the files
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { isSimpleRequest, toJobRequest } from '../src/api-request.ts';
import { cleanup, createJob, progressOf, step } from '../src/coordinator.ts';
import { toTrackerEvent } from '../src/events.ts';
import { createPresigner, type Presigner } from '../src/s3-presign.ts';
import type { Fleet, JobRequest, JobState, RenderProgress, Storage } from '../src/types.ts';

export type Env = {
  RENDER_JOB: DurableObjectNamespace<RenderJob>;
  RENDER_CONTAINER: DurableObjectNamespace<RenderContainer>;
  /** `wrangler secret put RENDER_SECRET`. Requests without it are refused; a service without it refuses everything. */
  RENDER_SECRET?: string;
  /** Optional R2 bucket for chunks and outputs. */
  RENDER_BUCKET?: R2Bucket;
  /** Optional, for presigned URLs: R2 S3 API keys (secrets) and the bucket's S3 endpoint data. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  /** "true": chunks and outputs go straight between the containers and R2 over presigned URLs (needs the four above). */
  R2_DIRECT?: string;
  SERVICE_NAME?: string;
  INSTANCE_TYPE?: string;
  MAX_INSTANCES_PER_RENDER?: string;
  ENABLE_INTERNET?: string;
  INACTIVITY_TIMEOUT_SECONDS?: string;
  /** JSON object of extra environment variables for the container. */
  CONTAINER_ENV?: string;
};

const PORT = 8080;
const R2_HOST = 'r2.internal';
const STEP_MS = 1500;
/** How long a URL in a task is good for. A task is handed out and used within minutes; a long join needs longer. */
const TASK_URL_SECONDS = 6 * 3600;

/** The presigner for this service's one bucket, or null when the S3 keys are not set. The bucket is never a parameter. */
function presignerOf(env: Env): Presigner | null {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET_NAME } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET_NAME) return null;
  return createPresigner({ endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, bucket: R2_BUCKET_NAME, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY });
}

/** One container instance. The Durable Object name is the instance name the coordinator chose. */
export class RenderContainer extends DurableObject<Env> {
  private timeoutMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.timeoutMs = Number(env.INACTIVITY_TIMEOUT_SECONDS ?? 180) * 1000;
    const container = ctx.container;
    // After a Durable Object restart the inactivity timeout is gone: set it again or the instance stops early.
    if (container?.running) void ctx.blockConcurrencyWhile(() => (container as any).setInactivityTimeout(this.timeoutMs));
  }

  private async ensureStarted(prefix: string) {
    const container = this.ctx.container as any;
    if (!container) throw new Error('No container is configured for this Durable Object');
    if (container.running) return;
    if (this.env.RENDER_BUCKET) {
      // The container reaches R2 as plain http://r2.internal/<key>; the gateway only serves keys under its own job.
      await container.interceptOutboundHttp(R2_HOST, (this.ctx as any).exports.R2Gateway({ props: { prefix } }));
    }
    container.start({
      image: container.images.render,
      instance: this.env.INSTANCE_TYPE ?? 'standard-4',
      enableInternet: this.env.ENABLE_INTERNET !== 'false',
      env: { PORT: String(PORT), ...(JSON.parse(this.env.CONTAINER_ENV ?? '{}') as Record<string, string>) },
    });
    await container.setInactivityTimeout(this.timeoutMs);
    // monitor() resolves when the container exits; the coordinator notices through its polls, so this only logs.
    this.ctx.waitUntil(container.monitor().then(() => console.log('container exited'), (error: unknown) => console.error('container failed:', error)));
  }

  /** Forwards a request to the task server. Answers 503 while the server is not listening yet: callers retry. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try { await this.ensureStarted(request.headers.get('x-render-prefix') ?? 'renders/unknown/'); }
    catch (error) { return new Response(`start failed: ${error instanceof Error ? error.message : error}`, { status: 503 }); }
    const port = (this.ctx.container as any).getTcpPort(PORT);
    const forwarded = new Request(`http://container${url.pathname}${url.search}`, request);
    forwarded.headers.delete('host');
    forwarded.headers.delete('x-render-prefix');
    try { return await port.fetch(forwarded); }
    catch (error) { return new Response(`not ready: ${error instanceof Error ? error.message : error}`, { status: 503 }); }
  }

  async destroyContainer(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAll();
  }
}

/** Serves R2 to a container. GET and PUT of one object, and multipart upload for outputs above the 100 MiB request limit. */
export class R2Gateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const bucket = this.env.RENDER_BUCKET;
    if (!bucket) return new Response('no bucket', { status: 501 });
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    const prefix = ((this.ctx as any).props as { prefix: string }).prefix;
    if (!key.startsWith(prefix) || key.includes('..')) return new Response('forbidden', { status: 403 });
    if (request.method === 'GET') {
      const object = await bucket.get(key);
      return object ? new Response(object.body, { headers: { 'content-length': String(object.size), etag: object.httpEtag } }) : new Response('not found', { status: 404 });
    }
    const uploadId = url.searchParams.get('uploadId');
    if (request.method === 'POST' && url.searchParams.has('uploads')) return Response.json({ uploadId: (await bucket.createMultipartUpload(key)).uploadId });
    if (request.method === 'PUT' && uploadId) {
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(Number(url.searchParams.get('partNumber')), request.body!);
      return Response.json(part);
    }
    if (request.method === 'POST' && uploadId) {
      const object = await bucket.resumeMultipartUpload(key, uploadId).complete((await request.json()) as R2UploadedPart[]);
      return Response.json({ key: object.key, size: object.size });
    }
    if (request.method === 'PUT') {
      // R2 needs to know the length of a stream: the container always sends Content-Length. With the SHA-256 of the
      // file in `x-sha256`, R2 itself refuses a body that arrived damaged.
      const sha256 = request.headers.get('x-sha256');
      const object = await bucket.put(key, request.body, /^[0-9a-f]{64}$/.test(sha256 ?? '') ? { sha256: sha256! } : {});
      return Response.json({ key: object?.key, size: object?.size });
    }
    return new Response('method not allowed', { status: 405 });
  }
}

/** One render. The alarm is the loop; the state survives restarts because it lives in Durable Object storage. */
export class RenderJob extends DurableObject<Env> {
  private fleet(job: JobState): Fleet {
    const env = this.env;
    return {
      async fetch(instance, path, init = {}) {
        const headers = new Headers(init.headers);
        headers.set('x-render-prefix', `renders/${job.id}/`);
        let body = init.body;
        // A stream with a known length must be sent as a fixed-length body, or the container cannot know when it ends.
        const length = headers.get('content-length');
        if (body instanceof ReadableStream && length) { const fixed = new FixedLengthStream(Number(length)); void body.pipeTo(fixed.writable).catch(() => undefined); body = fixed.readable; }
        return env.RENDER_CONTAINER.getByName(instance).fetch(new Request(`http://container${path}`, { method: init.method ?? 'GET', headers, body: body ?? null, signal: init.signal ?? null }));
      },
      async destroy(instance) { await env.RENDER_CONTAINER.getByName(instance).destroyContainer(); },
    };
  }
  private storage(): Storage | null {
    if (!this.env.RENDER_BUCKET) return null;
    // Direct: real presigned URLs, one per object a task reads or writes. The keys the coordinator asks for are all
    // under renders/<this render>/ (objectKey() in ../src/coordinator.ts); the presigner knows one bucket only.
    const presigner = this.env.R2_DIRECT === 'true' ? presignerOf(this.env) : null;
    if (presigner) return { presignPut: (key) => presigner.presign('PUT', key, {}, TASK_URL_SECONDS), presignGet: (key) => presigner.presign('GET', key, {}, TASK_URL_SECONDS) };
    // Default, not presigned at all: inside the container these URLs are intercepted and answered by R2Gateway.
    return { presignPut: async (key) => `http://${R2_HOST}/${key}`, presignGet: async (key) => `http://${R2_HOST}/${key}` };
  }
  private load = () => this.ctx.storage.get<JobState>('job');

  async start(id: string, request: JobRequest): Promise<{ renderId: string }> {
    if (await this.load()) throw new Error('render already exists');
    await this.ctx.storage.put('job', createJob(id, request));
    await this.ctx.storage.setAlarm(Date.now());
    return { renderId: id };
  }

  async alarm(): Promise<void> {
    const job = await this.load();
    if (!job) return;
    if (job.phase === 'done' || job.phase === 'failed') {
      // Nobody fetched or deleted the result: stop paying for the instance that holds it.
      if (job.phase === 'failed' || Date.now() - (job.finishedAt ?? 0) > 15 * 60_000) { await cleanup(job, this.fleet(job)); await this.ctx.storage.put('job', job); return; }
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const known = new Set(job.errors);
    await step(job, this.fleet(job), this.storage());
    await this.ctx.storage.put('job', job);
    // One JSON line per new event: Workers Logs can filter on `kind`, and a Tail Worker or Logpush can forward them
    // to an error tracker (docs/failures.md).
    for (const error of job.errors) if (!known.has(error)) console.log(JSON.stringify(toTrackerEvent(job.id, error, { phase: job.phase, service: this.env.SERVICE_NAME ?? 'render-service' })));
    await this.ctx.storage.setAlarm(Date.now() + ((job.phase as string) === 'done' ? 60_000 : STEP_MS));
  }

  async progress(): Promise<RenderProgress | null> {
    const job = await this.load();
    return job ? progressOf(job) : null;
  }

  /** The output as a stream: from R2 when a bucket is attached, otherwise straight from the instance that holds it. */
  async fetch(request: Request): Promise<Response> {
    const job = await this.load();
    if (!job?.output) return new Response('no output yet', { status: 409 });
    const name = `${job.id}.${job.output.name.split('.').pop()}`;
    const type = ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac' } as Record<string, string>)[name.split('.').pop()!] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'content-length': String(job.output.bytes), 'content-disposition': `attachment; filename="${name}"`, 'x-sha256': job.output.sha256 };
    const presign = new URL(request.url).searchParams.get('presign');
    if (presign) {
      const presigner = presignerOf(this.env);
      if (!job.output.key || !presigner) return new Response('presigned URLs need an R2 bucket and R2 S3 API keys on the service', { status: 501 });
      return Response.json({ url: await presigner.presign('GET', job.output.key, { 'response-content-disposition': `attachment; filename="${name}"` }, Number(presign) || 3600) });
    }
    if (job.output.key) {
      const object = await this.env.RENDER_BUCKET!.get(job.output.key);
      return object ? new Response(object.body, { headers }) : new Response('output is gone', { status: 404 });
    }
    const response = await this.fleet(job).fetch(job.output.instance!, `/files/${job.id}/${job.output.name}`);
    if (!response.ok) return new Response(`the instance that held the output is gone (${response.status}); render again or attach R2`, { status: 410 });
    return new Response(response.body, { headers });
  }

  /** Stops the render and its instances. The state stays readable; the files go with DELETE. */
  async cancel(): Promise<RenderProgress | null> {
    const job = await this.load();
    if (!job) return null;
    if (job.phase !== 'done' && job.phase !== 'failed') { await cleanup(job, this.fleet(job)); await this.ctx.storage.put('job', job); }
    return progressOf(job);
  }

  async remove(): Promise<void> {
    const job = await this.load();
    if (!job) return;
    await cleanup(job, this.fleet(job));
    // Every run of a chunk has its own objects, and a long render has thousands: a listing returns at most 1000 at a time.
    for (let cursor: string | undefined, more = Boolean(this.env.RENDER_BUCKET); more;) {
      const listed = await this.env.RENDER_BUCKET!.list({ prefix: `renders/${job.id}/`, ...(cursor ? { cursor } : {}) });
      if (listed.objects.length) await this.env.RENDER_BUCKET!.delete(listed.objects.map((object) => object.key));
      more = listed.truncated;
      cursor = listed.truncated ? listed.cursor : undefined;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/** HMAC-SHA256 of `message` with RENDER_SECRET, hex. Links signed with it need no Authorization header. */
async function sign(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RENDER_SECRET ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function signedLink(env: Env, origin: string, path: string, seconds: number): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(seconds, 7 * 86400));
  return `${origin}${path}?expires=${expires}&sig=${await sign(env, `${path}:${expires}`)}`;
}
/** A link made by signedLink(): right signature, not expired. Compared in constant time. */
async function validLink(env: Env, url: URL): Promise<boolean> {
  const expires = Number(url.searchParams.get('expires'));
  const given = url.searchParams.get('sig') ?? '';
  if (!env.RENDER_SECRET || env.RENDER_SECRET.length < 16 || !(expires > Date.now() / 1000)) return false;
  const expected = await sign(env, `${url.pathname}:${expires}`);
  let difference = given.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ (given.charCodeAt(index) || 0);
  return difference === 0;
}

const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function authorized(request: Request, env: Env): boolean {
  const secret = env.RENDER_SECRET ?? '';
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (secret.length < 16 || given.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1) difference |= secret.charCodeAt(index) ^ given.charCodeAt(index);
  return difference === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Signed links (uploads for the containers, outputs for whoever you give the link): no secret, GET only.
    if (request.method === 'GET' && url.searchParams.has('sig')) {
      if (!(await validLink(env, url))) return new Response('link expired or invalid', { status: 403 });
      const upload = /^\/files\/(uploads\/[0-9a-f]{32}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(url.pathname);
      if (upload && env.RENDER_BUCKET) {
        const object = await env.RENDER_BUCKET.get(upload[1]!);
        return object ? new Response(object.body, { headers: { 'content-length': String(object.size), etag: object.httpEtag, 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream' } }) : new Response('not found', { status: 404 });
      }
      const output = /^\/renders\/(r[0-9a-f]{12})\/output$/.exec(url.pathname);
      if (output) return env.RENDER_JOB.getByName(output[1]!).fetch(new Request(`http://job/output`));
      return new Response('not found', { status: 404 });
    }
    if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
    const maxInstances = Number(env.MAX_INSTANCES_PER_RENDER ?? 4);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: env.SERVICE_NAME ?? 'render-service', storage: Boolean(env.RENDER_BUCKET), instanceType: env.INSTANCE_TYPE ?? 'standard-4', maxInstancesPerRender: maxInstances });
    }
    const uploadPut = /^\/uploads\/([^/]+)$/.exec(url.pathname);
    if (uploadPut && request.method === 'PUT') {
      // Input files (images, video, audio, JSON) that a composition reads by URL. Not code: the bundle is in the image.
      if (!env.RENDER_BUCKET) return Response.json({ error: 'uploads need an R2 bucket bound as RENDER_BUCKET' }, { status: 501 });
      const name = decodeURIComponent(uploadPut[1]!);
      if (!UPLOAD_NAME.test(name)) return Response.json({ error: 'file name: letters, digits, dot, dash, underscore' }, { status: 400 });
      if (!request.body) return Response.json({ error: 'empty body' }, { status: 400 });
      const uploadId = crypto.randomUUID().replaceAll('-', '');
      const key = `uploads/${uploadId}/${name}`;
      const object = await env.RENDER_BUCKET.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' } });
      return Response.json({ uploadId, name, bytes: object?.size ?? 0, url: await signedLink(env, url.origin, `/files/${key}`, 7 * 86400) }, { status: 201 });
    }
    if (uploadPut && request.method === 'DELETE' && /^[0-9a-f]{32}$/.test(uploadPut[1]!) && env.RENDER_BUCKET) {
      const listed = await env.RENDER_BUCKET.list({ prefix: `uploads/${uploadPut[1]}/` });
      if (listed.objects.length) await env.RENDER_BUCKET.delete(listed.objects.map((object) => object.key));
      return Response.json({ deleted: uploadPut[1], objects: listed.objects.length });
    }
    if (request.method === 'POST' && url.pathname === '/renders') {
      let body = (await request.json().catch(() => null)) as JobRequest | null;
      if (isSimpleRequest(body)) {
        const translated = toJobRequest(body, maxInstances);
        if ('error' in translated) return Response.json({ error: translated.error }, { status: 400 });
        body = translated.request;
      }
      if (!body || typeof body.render !== 'object' || body.render === null) return Response.json({ error: 'body must be { render: {...}, fleet?: {...} }' }, { status: 400 });
      const instances = Math.floor(body.fleet?.instances ?? 1);
      if (!(instances >= 1 && instances <= maxInstances)) return Response.json({ error: `fleet.instances must be 1 to ${maxInstances} (MAX_INSTANCES_PER_RENDER)` }, { status: 400 });
      const id = `r${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      return Response.json(await env.RENDER_JOB.getByName(id).start(id, body), { status: 202 });
    }
    const match = /^\/renders\/(r[0-9a-f]{12})(\/output|\/link|\/cancel)?$/.exec(url.pathname);
    if (match) {
      const job = env.RENDER_JOB.getByName(match[1]!);
      if (match[2] === '/link' && request.method === 'GET') {
        const progress = await job.progress();
        if (!progress?.done) return Response.json({ error: 'no output yet' }, { status: 409 });
        return Response.json({ url: await signedLink(env, url.origin, `/renders/${match[1]}/output`, Number(url.searchParams.get('expires')) || 3600) });
      }
      if (match[2] === '/cancel' && request.method === 'POST') { const progress = await job.cancel(); return progress ? Response.json(progress) : Response.json({ error: 'no such render' }, { status: 404 }); }
      if (match[2] === '/output' && request.method === 'GET') return job.fetch(request);
      if (!match[2] && request.method === 'GET') { const progress = await job.progress(); return progress ? Response.json(progress) : Response.json({ error: 'no such render' }, { status: 404 }); }
      if (!match[2] && request.method === 'DELETE') { await job.remove(); return Response.json({ deleted: match[1] }); }
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
