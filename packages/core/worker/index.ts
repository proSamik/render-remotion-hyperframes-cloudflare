/**
 * The render service on Cloudflare: one Worker, two Durable Object classes.
 *
 *   Worker            checks the secret, routes /renders
 *   RenderJob         one per render: holds the job state and runs the coordinator from an alarm every 1.5 s
 *   RenderContainer   one per container instance: starts the container (ctx.container) and forwards HTTP to it
 *   R2Gateway         optional: lets a container read and write its own job's objects in R2 without credentials
 *
 * Written against the Durable Object Container API (`ctx.container`, scheduling_policy "durable_object"), which
 * replaced the `Container` class of `@cloudflare/containers` in the Cloudflare docs in November 2026.
 *
 * HTTP API (every request needs `Authorization: Bearer <RENDER_SECRET>`):
 *   GET    /health                    -> { ok, service, storage, instanceType, maxInstancesPerRender }
 *   POST   /renders  { render, fleet } -> { renderId }
 *   GET    /renders/<id>              -> progress (see RenderProgress in ../src/types.ts)
 *   GET    /renders/<id>/output       -> the file; with ?presign=<seconds> a time-limited R2 URL as { url }
 *   DELETE /renders/<id>              -> stops the instances, deletes the files
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { AwsClient } from 'aws4fetch';
import { cleanup, createJob, progressOf, step } from '../src/coordinator.ts';
import type { Fleet, JobRequest, JobState, RenderProgress, Storage } from '../src/types.ts';

export type Env = {
  RENDER_JOB: DurableObjectNamespace<RenderJob>;
  RENDER_CONTAINER: DurableObjectNamespace<RenderContainer>;
  /** `wrangler secret put RENDER_SECRET`. Requests without it are refused; a service without it refuses everything. */
  RENDER_SECRET?: string;
  /** Optional R2 bucket for chunks and outputs. */
  RENDER_BUCKET?: R2Bucket;
  /** Optional, only for presigned download URLs: R2 S3 API keys (secrets) and the bucket's S3 endpoint data. */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
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
      // R2 needs to know the length of a stream: the container always sends Content-Length.
      const object = await bucket.put(key, request.body);
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
    // Not presigned at all: inside the container these URLs are intercepted and answered by R2Gateway.
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
    await step(job, this.fleet(job), this.storage());
    await this.ctx.storage.put('job', job);
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
      const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET_NAME } = this.env;
      if (!job.output.key || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET_NAME) return new Response('presigned URLs need an R2 bucket and R2 S3 API keys on the service', { status: 501 });
      const client = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
      const target = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${job.output.key}`);
      target.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604800, Number(presign) || 3600))));
      target.searchParams.set('response-content-disposition', `attachment; filename="${name}"`);
      const signed = await client.sign(new Request(target, { method: 'GET' }), { aws: { signQuery: true } });
      return Response.json({ url: signed.url });
    }
    if (job.output.key) {
      const object = await this.env.RENDER_BUCKET!.get(job.output.key);
      return object ? new Response(object.body, { headers }) : new Response('output is gone', { status: 404 });
    }
    const response = await this.fleet(job).fetch(job.output.instance!, `/files/${job.id}/${job.output.name}`);
    if (!response.ok) return new Response(`the instance that held the output is gone (${response.status}); render again or attach R2`, { status: 410 });
    return new Response(response.body, { headers });
  }

  async remove(): Promise<void> {
    const job = await this.load();
    if (!job) return;
    await cleanup(job, this.fleet(job));
    if (this.env.RENDER_BUCKET) { const listed = await this.env.RENDER_BUCKET.list({ prefix: `renders/${job.id}/` }); if (listed.objects.length) await this.env.RENDER_BUCKET.delete(listed.objects.map((object) => object.key)); }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

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
    if (!authorized(request, env)) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    const maxInstances = Number(env.MAX_INSTANCES_PER_RENDER ?? 4);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: env.SERVICE_NAME ?? 'render-service', storage: Boolean(env.RENDER_BUCKET), instanceType: env.INSTANCE_TYPE ?? 'standard-4', maxInstancesPerRender: maxInstances });
    }
    if (request.method === 'POST' && url.pathname === '/renders') {
      const body = (await request.json().catch(() => null)) as JobRequest | null;
      if (!body || typeof body.render !== 'object' || body.render === null) return Response.json({ error: 'body must be { render: {...}, fleet?: {...} }' }, { status: 400 });
      const instances = Math.floor(body.fleet?.instances ?? 1);
      if (!(instances >= 1 && instances <= maxInstances)) return Response.json({ error: `fleet.instances must be 1 to ${maxInstances} (MAX_INSTANCES_PER_RENDER)` }, { status: 400 });
      const id = `r${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      return Response.json(await env.RENDER_JOB.getByName(id).start(id, body), { status: 202 });
    }
    const match = /^\/renders\/(r[0-9a-f]{12})(\/output)?$/.exec(url.pathname);
    if (match) {
      const job = env.RENDER_JOB.getByName(match[1]!);
      if (match[2] && request.method === 'GET') return job.fetch(request);
      if (!match[2] && request.method === 'GET') { const progress = await job.progress(); return progress ? Response.json(progress) : Response.json({ error: 'no such render' }, { status: 404 }); }
      if (!match[2] && request.method === 'DELETE') { await job.remove(); return Response.json({ deleted: match[1] }); }
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
