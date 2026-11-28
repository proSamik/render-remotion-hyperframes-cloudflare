/**
 * Presigned URLs for an S3 endpoint (R2: https://<account id>.r2.cloudflarestorage.com), with WebCrypto only, so the
 * same code runs in a Worker and in Node.
 *
 * A presigned URL is the whole permission: one method, one key, a time limit. Whoever holds it needs no keys. That is
 * how bytes can go straight between a client or a container and the bucket while the secret stays in the Worker.
 *
 * Path style only: <endpoint>/<bucket>/<key>. The bucket is fixed when the presigner is made; no call takes a bucket.
 * The payload is not signed (`UNSIGNED-PAYLOAD`), as for every presigned URL: check what arrived (ETag, SHA-256).
 */
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes as ArrayBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
/** RFC 3986, as SigV4 wants it: encodeURIComponent leaves !'()* alone. */
export const encodeRfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export const encodeKey = (key: string) => key.split('/').map(encodeRfc3986).join('/');
export const canonicalQuery = (query: Record<string, string>) => Object.keys(query).sort().map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name]!)}`).join('&');

async function hmac(key: Uint8Array, text: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(text)));
}

export type S3Method = 'GET' | 'PUT' | 'HEAD' | 'POST' | 'DELETE';
export type PresignerOptions = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string; now?: () => number };
export type Presigner = {
  bucket: string;
  /** `key` '' is the bucket itself (ListMultipartUploads). `query` carries the multipart parameters. */
  presign(method: S3Method, key: string, query?: Record<string, string>, expiresInSeconds?: number): Promise<string>;
};

export function createPresigner(options: PresignerOptions): Presigner {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = options;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('createPresigner: endpoint, bucket, accessKeyId and secretAccessKey are required');
  const region = options.region ?? 'auto';
  const origin = new URL(endpoint);
  // The signing key changes once a day: four HMACs to derive it, then two per URL. A long job signs thousands.
  let cached: { date: string; key: Uint8Array } | null = null;
  return {
    bucket,
    async presign(method, key, query = {}, expiresInSeconds = 3600) {
      const amzDate = new Date((options.now ?? Date.now)()).toISOString().replace(/[:-]|\.\d{3}/g, '');
      const date = amzDate.slice(0, 8);
      const scope = `${date}/${region}/s3/aws4_request`;
      const path = key ? `/${bucket}/${encodeKey(key)}` : `/${bucket}`;
      const parameters: Record<string, string> = {
        ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
        // S3 and R2 accept 1 second to 7 days.
        'X-Amz-Expires': String(Math.max(1, Math.min(604800, Math.floor(expiresInSeconds)))), 'X-Amz-SignedHeaders': 'host',
      };
      const request = [method, path, canonicalQuery(parameters), `host:${origin.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
      const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await crypto.subtle.digest('SHA-256', encoder.encode(request)))].join('\n');
      if (cached?.date !== date) {
        let derived = encoder.encode(`AWS4${secretAccessKey}`) as Uint8Array;
        for (const part of [date, region, 's3', 'aws4_request']) derived = await hmac(derived, part);
        cached = { date, key: derived };
      }
      return `${origin.protocol}//${origin.host}${path}?${canonicalQuery(parameters)}&X-Amz-Signature=${hex(await hmac(cached.key, toSign))}`;
    },
  };
}
