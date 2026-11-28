/**
 * Moving files in and out of an instance, with every byte checked.
 *
 * Why this exists: in the prototype of this design, files streamed from container to Worker to container sometimes
 * arrived with the right length and other content (89 of 1,800 in one run), and nothing reported an error. So:
 *   - a download is compared with the size and SHA-256 recorded where the file was made, BEFORE it gets its name;
 *   - an upload over a presigned URL is compared with the ETag the store answers (S3 and R2: the MD5 of the body);
 *   - an upload through the R2 gateway of ../worker carries the SHA-256, and R2 refuses a body that does not match.
 * Error messages never contain the query string of a URL: a presigned URL is a credential.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileInfo } from './types.ts';

export type TransferCode = 'checksum_mismatch' | 'download_error' | 'upload_error';
export class TransferError extends Error {
  code: TransferCode;
  /** false: asking again cannot help (an expired or refused URL). */
  retry: boolean;
  constructor(code: TransferCode, message: string, retry = true) { super(message); this.code = code; this.retry = retry; }
}

/** The container reaches R2 through the Worker under this host (see R2Gateway in ../worker/index.ts). RENDER_GATEWAY_URL points tests at a stand-in. */
export const GATEWAY = process.env.RENDER_GATEWAY_URL ?? 'http://r2.internal/';
// Files above this size are uploaded in parts. RENDER_MULTIPART_ABOVE_MIB exists so the multipart path can be tested with a small file.
const MULTIPART_ABOVE = Number(process.env.RENDER_MULTIPART_ABOVE_MIB ?? 90) * 1024 * 1024;
// R2 wants every part except the last to have the same size, at least 5 MiB.
export const PART_BYTES = Math.max(5, Math.min(64, Number(process.env.RENDER_MULTIPART_ABOVE_MIB ?? 64))) * 1024 * 1024;

export const cleanEtag = (etag: string | null | undefined) => (etag ?? '').replace(/^W\//, '').replaceAll('"', '').toLowerCase();
/** What may be shown of a URL: never the query. */
export const safeName = (url: string) => { try { return basename(new URL(url).pathname); } catch { return 'url'; } };
const transient = (status: number) => status >= 500 || status === 408 || status === 425 || status === 429;
const pause = (attempt: number) => new Promise((done) => setTimeout(done, Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2)));

/** Size, SHA-256 and MD5 of a file in one pass. */
export async function hashFile(path: string, name = basename(path)): Promise<Required<FileInfo>> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  for await (const data of createReadStream(path, { highWaterMark: 4 << 20 })) { sha256.update(data as Buffer); md5.update(data as Buffer); bytes += (data as Buffer).length; }
  return { name, bytes, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}

type Body = NonNullable<RequestInit['body']>;
type Options = { attempts?: number; signal?: AbortSignal; fetch?: typeof fetch };

/**
 * Downloads `url` into `path`. The bytes go to `<path>.part` first; the file appears under its name only when its
 * size and SHA-256 are what `expect` says. A wrong hash counts as an attempt and the download is repeated.
 */
export async function downloadVerified(url: string, path: string, expect: { bytes?: number; sha256?: string }, options: Options = {}): Promise<{ bytes: number; sha256: string }> {
  const attempts = options.attempts ?? 4;
  const part = `${path}.part`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await (options.fetch ?? fetch)(url, { signal: options.signal ?? null });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new TransferError('download_error', `download ${safeName(url)}: ${response.status}`, transient(response.status)); }
      const hash = createHash('sha256');
      let bytes = 0;
      const body = Readable.fromWeb(response.body as any);
      body.on('data', (data: Buffer) => { hash.update(data); bytes += data.length; });
      await pipeline(body, createWriteStream(part));
      const sha256 = hash.digest('hex');
      if ((expect.bytes !== undefined && bytes !== expect.bytes) || (expect.sha256 && sha256 !== expect.sha256)) throw new TransferError('checksum_mismatch', `${safeName(url)} arrived damaged (${bytes} bytes${expect.bytes === undefined ? '' : ` of ${expect.bytes}`}, hash ${sha256 === expect.sha256 ? 'equal' : 'differs'})`);
      await rename(part, path);
      return { bytes, sha256 };
    } catch (error) {
      await rm(part, { force: true });
      const known = error instanceof TransferError ? error : new TransferError('download_error', `download ${safeName(url)}: ${error instanceof Error ? error.message : String(error)}`);
      if (!known.retry || attempt + 1 >= attempts || options.signal?.aborted) throw known;
      await pause(attempt);
    }
  }
}

const fileBody = (path: string, start: number, end: number) => Readable.toWeb(createReadStream(path, { start, end: end - 1 })) as any;
async function refuse(response: Response, what: string): Promise<never> {
  throw new TransferError('upload_error', `upload ${what} failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`, transient(response.status));
}

/** The small multipart protocol of the R2 gateway: create, parts, complete. The object's size is compared at the end. */
async function gatewayParts(url: string, parts: AsyncIterable<{ number: number; bytes: number; body: () => Body }>, doFetch: typeof fetch, parallel = 1): Promise<number> {
  const created = await doFetch(`${url}?uploads`, { method: 'POST' });
  if (!created.ok) await refuse(created, safeName(url));
  const { uploadId } = (await created.json()) as { uploadId: string };
  const done: { partNumber: number }[] = [];
  const flying = new Set<Promise<void>>();
  let sent = 0;
  let failure: unknown = null;
  const sendPart = async (part: { number: number; bytes: number; body: () => Body }) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(`${url}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${part.number}`, { method: 'PUT', body: part.body(), headers: { 'content-length': String(part.bytes) }, duplex: 'half' } as RequestInit).catch(() => null);
      if (response?.ok) { done.push((await response.json()) as { partNumber: number }); sent += part.bytes; return; }
      if (attempt >= 4 || (response && !transient(response.status))) { if (response) await refuse(response, `part ${part.number} of ${safeName(url)}`); throw new TransferError('upload_error', `upload part ${part.number} of ${safeName(url)}: no answer`); }
      await response?.body?.cancel();
      await pause(attempt);
    }
  };
  for await (const part of parts) {
    if (failure) break;
    const flight: Promise<void> = sendPart(part).catch((error) => { failure ??= error; }).finally(() => flying.delete(flight));
    flying.add(flight);
    if (flying.size >= parallel) await Promise.race(flying);
  }
  await Promise.all(flying);
  if (failure) throw failure;
  const completed = await doFetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST', body: JSON.stringify(done.sort((a, b) => a.partNumber - b.partNumber)), headers: { 'content-type': 'application/json' } });
  if (!completed.ok) await refuse(completed, safeName(url));
  const { size } = (await completed.json()) as { size?: number };
  if (size !== undefined && size !== sent) throw new TransferError('checksum_mismatch', `${safeName(url)}: the stored object has ${size} bytes, ${sent} were sent`);
  return sent;
}

/**
 * Uploads a finished file. Through the gateway: one PUT with the SHA-256 (R2 checks it), or parts above 90 MiB,
 * because a request body through a Worker is limited to 100 MiB. To any other URL (a presigned PUT): one PUT, and the
 * ETag in the answer must be the MD5 of the file.
 */
export async function putFile(url: string, path: string, file: FileInfo, options: Options = {}): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const gateway = url.startsWith(GATEWAY);
  if (gateway && file.bytes > MULTIPART_ABOVE) {
    const parts = (async function* () { for (let start = 0, number = 1; start < file.bytes; start += PART_BYTES, number += 1) { const end = Math.min(file.bytes, start + PART_BYTES); yield { number, bytes: end - start, body: () => fileBody(path, start, end) }; } })();
    await gatewayParts(url, parts, doFetch);
    return;
  }
  const md5 = gateway ? null : file.md5 ?? (await hashFile(path)).md5;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await doFetch(url, { method: 'PUT', body: fileBody(path, 0, file.bytes), headers: { 'content-length': String(file.bytes), ...(gateway ? { 'x-sha256': file.sha256 } : {}) }, duplex: 'half', signal: options.signal ?? null } as RequestInit);
      if (!response.ok) await refuse(response, safeName(url));
      await response.body?.cancel();
      const etag = cleanEtag(response.headers.get('etag'));
      if (md5 && etag !== md5) throw new TransferError('checksum_mismatch', `${safeName(url)}: the store answered ETag ${etag || '(none)'}, the file's MD5 is ${md5}`);
      return;
    } catch (error) {
      const known = error instanceof TransferError ? error : new TransferError('upload_error', `upload ${safeName(url)}: ${error instanceof Error ? error.message : String(error)}`);
      if (!known.retry || attempt >= (options.attempts ?? 5) - 1 || options.signal?.aborted) throw known;
      await pause(attempt);
    }
  }
}

/**
 * Uploads a stream of unknown length while it is produced: it is cut into parts of exactly PART_BYTES and each part
 * leaves as soon as it is full. Nothing of the stream touches the disk; memory is `parallel` parts at most.
 * This is how a fragmented MP4 goes from the muxer's pipe to R2. Only the gateway speaks this protocol.
 */
export async function putStream(url: string, stream: AsyncIterable<Uint8Array>, name: string, options: Options & { partBytes?: number; parallel?: number } = {}): Promise<FileInfo> {
  if (!url.startsWith(GATEWAY)) throw new TransferError('upload_error', 'a streamed upload needs the R2 gateway (a bucket bound to the service)', false);
  const partBytes = options.partBytes ?? PART_BYTES;
  const sha256 = createHash('sha256');
  const parts = (async function* () {
    let held: Uint8Array[] = [];
    let size = 0;
    let number = 0;
    const cut = (length: number) => { const body = Buffer.concat(held, length); held = []; size = 0; number += 1; return { number, bytes: body.length, body: () => body as unknown as Body }; };
    for await (const data of stream) {
      sha256.update(data);
      let rest = data;
      while (size + rest.length >= partBytes) { const take = partBytes - size; held.push(rest.subarray(0, take)); rest = rest.subarray(take); yield cut(partBytes); }
      if (rest.length) { held.push(rest); size += rest.length; }
    }
    if (size || number === 0) yield cut(size);
  })();
  const bytes = await gatewayParts(url, parts, options.fetch ?? fetch, options.parallel ?? Math.max(1, Math.min(4, Math.floor((256 * 1024 * 1024) / partBytes))));
  return { name, bytes, sha256: sha256.digest('hex') };
}
