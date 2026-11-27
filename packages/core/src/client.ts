/**
 * HTTP client of a deployed render service (the Worker in ../worker). Plain fetch, no dependencies: it runs in Node,
 * in a Worker, in a browser-less agent sandbox.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JobRequest, RenderProgress } from './types.ts';

export type Service = { serviceUrl: string; secret: string };

/** Reads the service from the arguments or from RENDER_SERVICE_URL / RENDER_SECRET. */
export function serviceFrom(input: Partial<Service> = {}): Service {
  const serviceUrl = (input.serviceUrl ?? process.env.RENDER_SERVICE_URL ?? '').replace(/\/+$/, '');
  const secret = input.secret ?? process.env.RENDER_SECRET ?? '';
  if (!serviceUrl) throw new Error('No service URL: pass serviceUrl or set RENDER_SERVICE_URL (the URL `wrangler deploy` printed).');
  if (!secret) throw new Error('No secret: pass secret or set RENDER_SECRET (the value you gave `wrangler secret put RENDER_SECRET`).');
  return { serviceUrl, secret };
}

async function call(service: Service, path: string, init: RequestInit = {}): Promise<Response> {
  let last: unknown;
  // The platform answers 5xx now and then while an instance starts or moves. Reads are safe to repeat.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${service.serviceUrl}${path}`, { ...init, headers: { authorization: `Bearer ${service.secret}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
      if (response.status < 500 || (init.method && init.method !== 'GET')) return response;
      last = new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
    } catch (error) { last = error; if (init.method && init.method !== 'GET') break; }
    await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
  }
  throw last instanceof Error ? last : new Error(String(last));
}
async function okJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text) as T;
}

export const getServiceInfo = async (service: Service) => okJson<{ ok: boolean; service: string; storage: boolean; maxInstancesPerRender: number; instanceType: string }>(await call(service, '/health'));
export const startRender = async (service: Service, request: JobRequest) => okJson<{ renderId: string }>(await call(service, '/renders', { method: 'POST', body: JSON.stringify(request) }));
export const getProgress = async (service: Service, renderId: string) => okJson<RenderProgress>(await call(service, `/renders/${renderId}`));
export const deleteRender = async (service: Service, renderId: string) => okJson<{ deleted: string }>(await call(service, `/renders/${renderId}`, { method: 'DELETE' }));
/** A time-limited download URL. Only with R2 and S3 API keys configured on the service; otherwise null. */
export async function presign(service: Service, renderId: string, expiresInSeconds = 3600): Promise<string | null> {
  const response = await call(service, `/renders/${renderId}/output?presign=${expiresInSeconds}`);
  if (response.status === 409 || response.status === 501) { await response.body?.cancel(); return null; }
  return (await okJson<{ url: string }>(response)).url;
}

export async function waitForRender(service: Service, renderId: string, onProgress?: (progress: RenderProgress) => void, pollMs = 2000): Promise<RenderProgress> {
  for (;;) {
    const progress = await getProgress(service, renderId);
    onProgress?.(progress);
    if (progress.done) return progress;
    if (progress.fatalErrorEncountered) throw new Error(`render ${renderId} failed:\n${progress.errors.map((error) => `  ${error.message}`).join('\n')}`);
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** Streams the output to a file and checks it against the hash the instance computed. Returns the byte count. */
export async function downloadOutput(service: Service, renderId: string, outPath: string, expectedSha256?: string | null): Promise<{ outPath: string; sizeInBytes: number }> {
  const out = resolve(outPath);
  await mkdir(dirname(out), { recursive: true });
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await call(service, `/renders/${renderId}/output`);
      if (!response.ok || !response.body) throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`);
      const hash = createHash('sha256');
      let sizeInBytes = 0;
      const body = Readable.fromWeb(response.body as any);
      body.on('data', (chunk: Buffer) => { hash.update(chunk); sizeInBytes += chunk.length; });
      await pipeline(body, createWriteStream(out));
      if (expectedSha256 && hash.digest('hex') !== expectedSha256) throw new Error('the download arrived damaged (hash differs)');
      return { outPath: out, sizeInBytes };
    } catch (error) { last = error; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export const formatProgress = (progress: RenderProgress) =>
  `${String(Math.round(progress.overallProgress * 100)).padStart(3)} %  ${progress.phase.padEnd(9)} frames ${progress.framesRendered}/${progress.frames}  chunks ${progress.chunks.stored}/${progress.chunks.total}  instances ${progress.instances}  ~$${progress.costs.accruedSoFar.toFixed(4)}`;
