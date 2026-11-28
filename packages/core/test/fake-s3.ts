/**
 * A small S3 in memory for the tests: single PUT / GET (with Range) / HEAD and the multipart calls, path style
 * (`/<bucket>/<key>`). ETags behave like S3 and R2: MD5 of the body, and for a multipart object the MD5 of the parts'
 * MD5s plus "-N". It does not check signatures. It can also answer the gateway protocol of ../worker (JSON instead of XML).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
const read = async (request: IncomingMessage) => { const parts: Buffer[] = []; for await (const part of request) parts.push(part as Buffer); return Buffer.concat(parts); };

export async function startFakeS3(options: { gateway?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const uploads = new Map<string, { key: string; initiated: string; parts: Map<number, { body: Buffer; etag: string }> }>();
  const log: { method: string; key: string; query: string; bytes: number }[] = [];
  const state = {
    /** called before a request is answered; return a status to refuse it, or 'drop' to cut the connection */
    intercept: null as null | ((request: { method: string; key: string; query: URLSearchParams }) => number | 'drop' | void),
    /** one-shot: the next GET of an object answers with these bytes instead (right length, wrong content) */
    corruptNextGet: 0,
  };
  let counter = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = options.gateway ? decodeURIComponent(url.pathname.slice(1)) : rest.map(decodeURIComponent).join('/');
    const query = url.searchParams;
    const body = method === 'PUT' || method === 'POST' ? await read(request) : Buffer.alloc(0);
    log.push({ method, key, query: url.search, bytes: body.length });
    const xml = (status: number, text: string, headers: Record<string, string> = {}) => { response.writeHead(status, { 'content-type': 'application/xml', ...headers }); response.end(text); };
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const verdict = state.intercept?.({ method, key, query });
    if (verdict === 'drop') { request.socket.destroy(); return; }
    if (typeof verdict === 'number') return xml(verdict, '<Error><Code>Injected</Code></Error>');
    if (!bucket) return xml(400, '<Error><Code>NoBucket</Code></Error>');
    // bucket level: list multipart uploads
    if (!key && method === 'GET' && query.has('uploads')) {
      const prefix = query.get('prefix') ?? '';
      const found = [...uploads].filter(([, upload]) => upload.key.startsWith(prefix));
      return xml(200, `<ListMultipartUploadsResult>${found.map(([id, upload]) => `<Upload><Key>${upload.key}</Key><UploadId>${id}</UploadId><Initiated>${upload.initiated}</Initiated></Upload>`).join('')}</ListMultipartUploadsResult>`);
    }
    const uploadId = query.get('uploadId');
    if (method === 'POST' && query.has('uploads')) {
      const id = `upload-${(counter += 1)}`;
      uploads.set(id, { key, initiated: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(), parts: new Map() });
      return options.gateway ? json(200, { uploadId: id }) : xml(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
      if (method === 'PUT') {
        const number = Number(query.get('partNumber'));
        upload.parts.set(number, { body, etag: md5(body) });
        return options.gateway ? json(200, { partNumber: number, etag: md5(body) }) : xml(200, '', { etag: `"${md5(body)}"` });
      }
      if (method === 'GET') return xml(200, `<ListPartsResult><IsTruncated>false</IsTruncated>${[...upload.parts].sort((a, b) => a[0] - b[0]).map(([number, part]) => `<Part><PartNumber>${number}</PartNumber><ETag>&quot;${part.etag}&quot;</ETag><Size>${part.body.length}</Size></Part>`).join('')}</ListPartsResult>`);
      if (method === 'DELETE') { uploads.delete(uploadId); return xml(204, ''); }
      if (method === 'POST') {
        const parts = [...upload.parts].sort((a, b) => a[0] - b[0]).map(([, part]) => part);
        const whole = Buffer.concat(parts.map((part) => part.body));
        const etag = `${md5(Buffer.concat(parts.map((part) => Buffer.from(part.etag, 'hex'))))}-${parts.length}`;
        objects.set(key, { body: whole, etag });
        uploads.delete(uploadId);
        return options.gateway ? json(200, { key, size: whole.length }) : xml(200, `<CompleteMultipartUploadResult><ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
      }
    }
    if (method === 'PUT') {
      // like R2's put() with a checksum: a body that does not match is refused
      const claimed = request.headers['x-sha256'];
      if (claimed && claimed !== createHash('sha256').update(body).digest('hex')) return xml(400, '<Error><Code>BadDigest</Code></Error>');
      objects.set(key, { body, etag: md5(body) });
      return options.gateway ? json(200, { key, size: body.length }) : xml(200, '', { etag: `"${md5(body)}"` });
    }
    const object = objects.get(key);
    if (!object) return xml(404, '<Error><Code>NoSuchKey</Code></Error>');
    if (method === 'HEAD') { response.writeHead(200, { 'content-length': object.body.length, etag: `"${object.etag}"` }); return response.end(); }
    if (method === 'GET') {
      let bytes = object.body;
      if (state.corruptNextGet > 0) { state.corruptNextGet -= 1; bytes = Buffer.from(bytes); bytes[0] = bytes[0]! ^ 0xff; }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (range) { const piece = bytes.subarray(Number(range[1]), Number(range[2]) + 1); response.writeHead(206, { 'content-length': piece.length, 'content-range': `bytes ${range[1]}-${Number(range[1]) + piece.length - 1}/${bytes.length}` }); return response.end(piece); }
      response.writeHead(200, { 'content-length': bytes.length, etag: `"${object.etag}"` });
      return response.end(bytes);
    }
    return xml(405, '<Error><Code>MethodNotAllowed</Code></Error>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, objects, uploads, log, state, close: () => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}
