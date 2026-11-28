/**
 * A loopback proxy that serves remote files to the render page by byte range.
 *
 * A browser that plays a video for a frame does not read the file: it reads the container index and the samples
 * around the frame, with HTTP Range requests. So a chunk in the middle of a long recording needs a few megabytes of a
 * file of gigabytes. Downloading every input to every instance wastes most of the time and the disk. This proxy gives
 * the page `http://127.0.0.1:<port>/<name>` and fetches only what is asked for from the real URL (a presigned GET):
 *   - a request is answered from fixed-size blocks; a block is fetched once (`Range: bytes=a-b`, keep-alive,
 *     retried), kept in a small LRU cache and shared by every reader of the file (picture and sound read the same);
 *   - a sequential reader gets a little read-ahead in one upstream request;
 *   - a reader that asks for "the rest of the file" and leaves after a megabyte does not make the proxy fetch on.
 * In the prototype of this design a 10 s chunk in the middle of a 1.1 GB file fetched 26 to 30 MB of it.
 *
 * Integrity: a range cannot be compared with the file's SHA-256. The size the object announces must equal the recorded
 * size, and the transport is TLS. Download small files whole and verify them (transfer.ts); use ranges for large media.
 * The real URLs stay in this process: the page only ever sees the loopback address.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RemoteFile = { url: string; size: number; contentType?: string };
export type RangeStats = { requests: number; upstreamRequests: number; upstreamBytes: number; servedBytes: number; cacheHits: number; retries: number; perFile: Record<string, { size: number; upstreamBytes: number; upstreamRequests: number }> };
export type RangeOptions = { blockBytes?: number; cacheBytes?: number; readAheadBlocks?: number; fetch?: typeof fetch };

export function createRangeReader(files: Record<string, RemoteFile>, options: RangeOptions = {}) {
  const block = Math.max(64 * 1024, options.blockBytes ?? 1024 * 1024);
  const cacheBytes = Math.max(block * 4, options.cacheBytes ?? 96 * 1024 * 1024);
  const readAhead = Math.max(1, options.readAheadBlocks ?? 2);
  const doFetch = options.fetch ?? fetch;
  /** `${name}#${index}` -> bytes; insertion order is the LRU order */
  const cache = new Map<string, Uint8Array>();
  const flying = new Map<string, Promise<Uint8Array>>();
  let cached = 0;
  const stats: RangeStats = { requests: 0, upstreamRequests: 0, upstreamBytes: 0, servedBytes: 0, cacheHits: 0, retries: 0, perFile: {} };

  const remember = (key: string, bytes: Uint8Array) => {
    cache.set(key, bytes);
    cached += bytes.length;
    for (const [oldest, old] of cache) { if (cached <= cacheBytes) break; cache.delete(oldest); cached -= old.length; }
  };
  /** Blocks first..last of one file in ONE upstream request. */
  async function fetchBlocks(name: string, file: RemoteFile, first: number, last: number): Promise<Uint8Array> {
    const start = first * block;
    const end = Math.min(file.size, (last + 1) * block) - 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await doFetch(file.url, { headers: { range: `bytes=${start}-${end}` } });
        if (response.status !== 206 && response.status !== 200) { await response.body?.cancel(); throw new Error(`range request answered ${response.status}`); }
        const whole = new Uint8Array(await response.arrayBuffer());
        const announced = response.status === 206 ? Number(/\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? NaN) : whole.length;
        if (Number.isFinite(announced) && announced !== file.size) throw Object.assign(new Error(`${name} has ${announced} bytes at its source, ${file.size} were recorded`), { final: true });
        // A server that ignores Range answers 200 with everything: cut the wanted piece out of it.
        const body = response.status === 200 ? whole.subarray(start, end + 1) : whole;
        if (body.length !== end - start + 1) throw new Error(`short answer for ${name}: ${body.length} of ${end - start + 1} bytes`);
        const perFile = (stats.perFile[name] ??= { size: file.size, upstreamBytes: 0, upstreamRequests: 0 });
        stats.upstreamRequests += 1; stats.upstreamBytes += whole.length; perFile.upstreamRequests += 1; perFile.upstreamBytes += whole.length;
        return body;
      } catch (error) {
        if ((error as { final?: boolean }).final || attempt >= 3) throw error;
        stats.retries += 1;
        await new Promise((done) => setTimeout(done, 300 * 2 ** attempt));
      }
    }
  }
  function blockOf(name: string, file: RemoteFile, index: number, lastWanted: number): Promise<Uint8Array> {
    const key = `${name}#${index}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); stats.cacheHits += 1; return Promise.resolve(hit); }
    if (!flying.has(key)) {
      // One request for this block and the next missing ones this reader is about to ask for.
      let last = index;
      const limit = Math.min(lastWanted, index + readAhead - 1);
      while (last < limit && !cache.has(`${name}#${last + 1}`) && !flying.has(`${name}#${last + 1}`)) last += 1;
      const run = fetchBlocks(name, file, index, last);
      for (let each = index; each <= last; each += 1) {
        const one = run.then((body) => { const bytes = body.subarray((each - index) * block, (each - index + 1) * block); remember(`${name}#${each}`, bytes); return bytes; }).finally(() => flying.delete(`${name}#${each}`));
        one.catch(() => undefined);
        flying.set(`${name}#${each}`, one);
      }
    }
    return flying.get(key)!;
  }

  return {
    has: (name: string) => name in files,
    stats: (): RangeStats => ({ ...stats, perFile: { ...stats.perFile } }),
    /** Bytes start..end (inclusive) of a file, block by block. Stop iterating and nothing more is fetched. */
    async *read(name: string, start: number, end: number): AsyncGenerator<Uint8Array> {
      const file = files[name];
      if (!file) throw new Error(`no remote file ${name}`);
      const lastBlock = Math.floor(end / block);
      for (let index = Math.floor(start / block); index <= lastBlock; index += 1) {
        const bytes = await blockOf(name, file, index, lastBlock);
        const from = index * block;
        const piece = bytes.subarray(Math.max(0, start - from), Math.min(bytes.length, end - from + 1));
        stats.servedBytes += piece.length;
        yield piece;
      }
    },
    /** Answers GET and HEAD with or without a Range header, like a static file server would. */
    async serve(request: IncomingMessage, response: ServerResponse, name: string): Promise<void> {
      const file = files[name];
      if (!file) { response.writeHead(404).end(); return; }
      stats.requests += 1;
      const headers: Record<string, string | number> = { 'content-type': file.contentType ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-length, accept-ranges', 'cross-origin-resource-policy': 'cross-origin' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
      let start = 0;
      let end = file.size - 1;
      let status = 200;
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        if (start > end || start >= file.size) { response.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` }).end(); return; }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${file.size}`;
      }
      response.writeHead(status, { ...headers, 'content-length': end - start + 1 });
      if (request.method === 'HEAD') { response.end(); return; }
      let closed = false;
      const whenClosed = new Promise<void>((done) => response.on('close', () => { closed = true; done(); }));
      try {
        for await (const piece of this.read(name, start, end)) {
          if (closed) return;
          if (!response.write(piece)) await Promise.race([new Promise((done) => response.once('drain', done)), whenClosed]);
          if (closed) return;
        }
        response.end();
      } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))); }
    },
  };
}

/** Starts the proxy on a free loopback port. `urlFor(name)` is what goes into the composition's props. */
export async function startRangeProxy(files: Record<string, RemoteFile>, options: RangeOptions = {}) {
  const reader = createRangeReader(files, options);
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname.slice(1));
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    void reader.serve(request, response, name);
  });
  await new Promise<void>((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done); });
  const { port } = server.address() as AddressInfo;
  return { port, urlFor: (name: string) => `http://127.0.0.1:${port}/${name.split('/').map(encodeURIComponent).join('/')}`, stats: reader.stats, close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}
