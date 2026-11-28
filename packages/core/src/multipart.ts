/**
 * Client-side multipart upload of a large file to S3 or R2 over presigned URLs, resumable without any local state.
 *
 * Why: one PUT of a 2 GB recording that breaks at 90 % starts again at 0, and a request body through a Worker stops at
 * 100 MiB. In parts, the bytes go straight from the client to the bucket and only the missing parts are sent again.
 *
 *   - "Where was I?" is asked of the store, not of a file on the client: ListMultipartUploads finds the upload id of an
 *     interrupted upload of this key, ListParts says which parts arrived. A client that was reinstalled can resume.
 *   - A part that is listed is kept only when its size is right AND its ETag is the MD5 of the local bytes. For S3 and
 *     R2 the ETag of a part is the MD5 of its body, so a part with other bytes (the file changed) is sent again.
 *   - Every part sent is checked the same way: the ETag in the answer must be the MD5 computed while reading.
 *   - After the complete call the object's ETag must be the composite ETag: the MD5 of the parts' binary MD5s, then
 *     "-<number of parts>". A 200 answer to "complete" can still carry an <Error> body; that is checked too.
 *
 * The caller supplies `sign`: it returns a presigned URL for one call on this object (see signer.ts for the policy
 * that should stand behind it). This module never sees a key.
 */
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { cleanEtag } from './transfer.ts';

const MIB = 1024 * 1024;
export const MIN_PART_BYTES = 5 * MIB;
export const MAX_PARTS = 10_000;

/** Equal parts (R2 requires that, except for the last), at least 5 MiB, at most 10,000 of them. */
export function planParts(size: number, wanted = 32 * MIB): { partSize: number; count: number } {
  const partSize = Math.max(MIN_PART_BYTES, wanted, Math.ceil(size / MAX_PARTS / MIB) * MIB);
  return { partSize, count: Math.max(1, Math.ceil(size / partSize)) };
}

/** What S3 and R2 answer as the ETag of a completed multipart upload. */
export function compositeEtag(partMd5s: string[]): string {
  return `${createHash('md5').update(Buffer.concat(partMd5s.map((md5) => Buffer.from(md5, 'hex')))).digest('hex')}-${partMd5s.length}`;
}

export type ListedPart = { number: number; etag: string; size: number };
export type MultipartCall = { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; /** '' for the bucket-level listing */ key: string; query: Record<string, string> };
export type MultipartInput = {
  path: string;
  key: string;
  sign: (call: MultipartCall) => Promise<string>;
  partSize?: number;
  parallel?: number;
  /** false: a listed part with the right size is trusted without reading the local bytes again. Default true. */
  verifyResumedParts?: boolean;
  /** false: never look for an interrupted upload, always start a new one. Default true. */
  resume?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: { bytesDone: number; bytesTotal: number; partsDone: number; partsTotal: number }) => void;
};
export type MultipartResult = { etag: string; size: number; parts: number; partsResumed: number; bytesSent: number; uploadId: string };

const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null;
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((match) => match[1]!);
const unescapeXml = (text: string) => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pause = (attempt: number) => new Promise((done) => setTimeout(done, Math.min(8000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2)));

export async function uploadMultipart(input: MultipartInput): Promise<MultipartResult> {
  const doFetch = input.fetch ?? fetch;
  const size = (await stat(input.path)).size;
  const { partSize, count } = planParts(size, input.partSize);
  const call = async (what: string, request: MultipartCall, init: RequestInit = {}, ok: number[] = []) => {
    const response = await doFetch(await input.sign(request), { method: request.method, signal: input.signal ?? null, ...init });
    if (!response.ok && !ok.includes(response.status)) throw new Error(`${what}: ${response.status} ${tag(await response.text().catch(() => ''), 'Code') ?? ''}`.trim());
    return response;
  };

  // 1. Find the interrupted upload of this key, newest first, or start one.
  let uploadId: string | null = null;
  if (input.resume !== false) {
    const listing = await (await call('list uploads', { method: 'GET', key: '', query: { uploads: '', prefix: input.key, 'max-uploads': '1000' } })).text();
    uploadId = tags(listing, 'Upload').filter((upload) => unescapeXml(tag(upload, 'Key') ?? '') === input.key).sort((a, b) => String(tag(b, 'Initiated')).localeCompare(String(tag(a, 'Initiated')))).map((upload) => tag(upload, 'UploadId'))[0] ?? null;
  }
  let listed: ListedPart[] = [];
  if (uploadId) {
    // 2. Which parts are there. A 404 means the upload is gone (completed or aborted meanwhile): start again.
    for (let marker: string | null = null; ;) {
      const response: Response = await call('list parts', { method: 'GET', key: input.key, query: { uploadId, 'max-parts': '1000', ...(marker ? { 'part-number-marker': marker } : {}) } }, {}, [404]);
      const text = await response.text();
      if (response.status === 404) { uploadId = null; listed = []; break; }
      for (const part of tags(text, 'Part')) listed.push({ number: Number(tag(part, 'PartNumber')), etag: cleanEtag(unescapeXml(tag(part, 'ETag') ?? '')), size: Number(tag(part, 'Size')) });
      marker = tag(text, 'IsTruncated') === 'true' ? tag(text, 'NextPartNumberMarker') : null;
      if (!marker) break;
    }
  }
  if (!uploadId) {
    uploadId = tag(await (await call('create multipart upload', { method: 'POST', key: input.key, query: { uploads: '' } })).text(), 'UploadId');
    if (!uploadId) throw new Error('create multipart upload: the answer has no UploadId');
  }
  const id = uploadId;

  // 3. Send what is missing, a few parts at a time. One part is in memory per connection.
  const file = await open(input.path, 'r');
  const md5s: string[] = new Array(count);
  const have = new Map(listed.map((part) => [part.number, part]));
  let next = 1;
  let bytesDone = 0;
  let partsDone = 0;
  let partsResumed = 0;
  let bytesSent = 0;
  const report = () => input.onProgress?.({ bytesDone, bytesTotal: size, partsDone, partsTotal: count });
  const one = async (number: number) => {
    const length = Math.min(partSize, size - (number - 1) * partSize);
    const kept = have.get(number);
    const trusted = kept && kept.size === length && input.verifyResumedParts === false;
    let body: Buffer | null = null;
    if (!trusted) { body = Buffer.alloc(length); await file.read(body, 0, length, (number - 1) * partSize); }
    const md5 = body ? createHash('md5').update(body).digest('hex') : kept!.etag;
    md5s[number - 1] = md5;
    if (kept && kept.size === length && kept.etag === md5) { partsResumed += 1; }
    else {
      for (let attempt = 0; ; attempt += 1) {
        try {
          // A fresh URL for every try: the one from before may have expired in a long queue.
          const response = await call(`part ${number}`, { method: 'PUT', key: input.key, query: { uploadId: id, partNumber: String(number) } }, { body: body as unknown as NonNullable<RequestInit['body']>, headers: { 'content-length': String(length) } });
          await response.body?.cancel();
          const etag = cleanEtag(response.headers.get('etag'));
          if (etag !== md5) throw new Error(`part ${number}: the store answered ETag ${etag || '(none)'}, the bytes have MD5 ${md5}`);
          break;
        } catch (error) {
          if (attempt >= 4 || input.signal?.aborted) throw error;
          await pause(attempt);
        }
      }
      bytesSent += length;
    }
    bytesDone += length;
    partsDone += 1;
    report();
  };
  try {
    await Promise.all(Array.from({ length: Math.min(count, Math.max(1, input.parallel ?? 4)) }, async () => { for (let number = next++; number <= count; number = next++) await one(number); }));
  } finally { await file.close(); }

  // 4. Complete, and compare what the store made of it with what was sent.
  const body = `<CompleteMultipartUpload>${md5s.map((md5, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>"${md5}"</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const answer = await (await call('complete multipart upload', { method: 'POST', key: input.key, query: { uploadId: id } }, { body, headers: { 'content-type': 'application/xml' } })).text();
  if (/<Error>/.test(answer)) throw new Error(`complete multipart upload: ${tag(answer, 'Code') ?? 'error'} ${tag(answer, 'Message') ?? ''}`.trim());
  const etag = cleanEtag(unescapeXml(tag(answer, 'ETag') ?? ''));
  const expected = compositeEtag(md5s);
  if (etag !== expected) throw new Error(`the object has ETag ${etag || '(none)'} after the upload, expected ${expected}`);
  return { etag, size, parts: count, partsResumed, bytesSent, uploadId: id };
}
