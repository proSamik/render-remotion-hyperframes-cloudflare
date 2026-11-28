/**
 * A narrow signing policy in front of the presigner.
 *
 * The S3 key behind a service can usually do more than one render needs: every key of the bucket, sometimes other
 * buckets of the account. So nothing is signed because a caller asked for it. A request is signed only when it fits
 * the scope of who asks:
 *   - one bucket, fixed where the presigner is made: never a parameter;
 *   - inputs under the user's own prefix, content-addressed:   inputs/<user>/<sha256>
 *   - everything of a job under that job's own prefix:          jobs/<user>/<job>/...
 *   - only GET, PUT, HEAD and the multipart calls; DELETE and listing only for a cleanup scope;
 *   - a time limit of at most 6 hours.
 * Everything else is refused, with the reason. Containers never see a key: the coordinator signs the few URLs a task
 * needs (this chunk's inputs, this run's output key) and puts them into the task.
 *
 * The service's own storage calls should pass the same check (`refusal()`), so that a bug elsewhere cannot touch
 * another user's objects either.
 */
import type { Presigner, S3Method } from './s3-presign.ts';

export const MAX_EXPIRES_SECONDS = 6 * 3600;
const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type Scope = { user: string; job: string; /** adds DELETE and listing under the job's prefix */ cleanup?: boolean };
export type SignRequest = { method: S3Method; key?: string; query?: Record<string, string | number>; expiresInSeconds?: number };
export class SignerRefusal extends Error { code = 'forbidden'; constructor(reason: string) { super(`not allowed: ${reason}`); } }

export const keys = {
  input: (user: string, sha256: string) => `inputs/${user}/${sha256}`,
  jobPrefix: (user: string, job: string) => `jobs/${user}/${job}/`,
  /** One object per run of a chunk: a retry or a hedge never writes where another run wrote. */
  chunk: (user: string, job: string, index: number, run: number, extension = 'bin') => `jobs/${user}/${job}/chunks/c${String(index).padStart(5, '0')}-r${run}.${extension}`,
  output: (user: string, job: string, name = 'output.mp4') => `jobs/${user}/${job}/${name}`,
};

/** What kind of object a key is for this scope, or null. Strict patterns: no "..", no empty segment, nobody else's prefix. */
function classify(scope: Scope, key: string): 'input' | 'chunk' | 'file' | null {
  if (key.length > 400) return null;
  const inputs = `inputs/${scope.user}/`;
  if (key.startsWith(inputs)) return /^[0-9a-f]{64}$/.test(key.slice(inputs.length)) ? 'input' : null;
  const prefix = keys.jobPrefix(scope.user, scope.job);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (/^chunks\/c\d{5}-r\d{1,4}\.[a-z0-9]{1,5}$/.test(rest)) return 'chunk';
  return NAME.test(rest) && !rest.includes('..') ? 'file' : null;
}

/** null when the request may be signed, otherwise the reason it is refused. */
export function refusal(scope: Scope, request: SignRequest): string | null {
  if (!scope || !ID.test(String(scope.user)) || !ID.test(String(scope.job))) return 'bad scope';
  const expires = request.expiresInSeconds ?? 3600;
  if (!Number.isFinite(expires) || expires < 1 || expires > MAX_EXPIRES_SECONDS) return 'expiry over 6 hours';
  const query = request.query ?? {};
  const names = Object.keys(query);
  const only = (...allowed: string[]) => names.every((name) => allowed.includes(name));
  const key = request.key ?? '';
  if (key === '') {
    // Bucket level: a listing, always pinned to a prefix inside the scope.
    const prefix = String(query.prefix ?? '');
    if (request.method !== 'GET') return 'bucket-level method';
    // In-progress multipart uploads of ONE input object: how an interrupted upload finds its upload id again.
    if ('uploads' in query) return only('uploads', 'prefix', 'max-uploads') && classify(scope, prefix) === 'input' ? null : 'upload listing outside the user\'s inputs';
    if (scope.cleanup && String(query['list-type']) === '2') return only('list-type', 'prefix', 'max-keys', 'continuation-token') && prefix === keys.jobPrefix(scope.user, scope.job) ? null : 'listing outside the job';
    return 'bucket-level request';
  }
  const kind = classify(scope, key);
  if (!kind) return `key ${key.slice(0, 80)}`;
  if (names.length === 0) {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'PUT') return null;
    // Inputs are shared by a user's jobs: cleaning up one job never deletes them.
    if (request.method === 'DELETE' && scope.cleanup && kind !== 'input') return null;
    return `method ${request.method}`;
  }
  // Multipart: large inputs and the output. A chunk is one PUT.
  if (kind === 'chunk') return 'query on a chunk object';
  if (request.method === 'POST' && names.length === 1 && query.uploads === '') return null; // create
  if (!/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(String(query.uploadId ?? ''))) return 'bad multipart query';
  if (request.method === 'PUT' && only('uploadId', 'partNumber') && /^([1-9]\d{0,3}|10000)$/.test(String(query.partNumber))) return null; // one part
  if (request.method === 'POST' && only('uploadId')) return null; // complete
  if (request.method === 'DELETE' && only('uploadId')) return null; // abort
  if (request.method === 'GET' && only('uploadId', 'max-parts', 'part-number-marker')) return null; // list parts
  return `multipart ${request.method}`;
}

/** sign(scope, request) -> URL, or throws SignerRefusal. */
export function createSigner(presigner: Presigner) {
  return {
    async sign(scope: Scope, request: SignRequest): Promise<string> {
      const reason = refusal(scope, request);
      if (reason) throw new SignerRefusal(reason);
      return presigner.presign(request.method, request.key ?? '', Object.fromEntries(Object.entries(request.query ?? {}).map(([name, value]) => [name, String(value)])), request.expiresInSeconds ?? 3600);
    },
  };
}
