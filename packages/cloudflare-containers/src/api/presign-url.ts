import { presign } from '../../../core/src/client.ts';
import { resolveService } from './service.ts';
import type { ServiceInput } from './types.ts';

export type PresignUrlInput = ServiceInput & { renderId: string; expiresInSeconds: number };

/**
 * A time-limited public URL of a finished render. Needs an R2 bucket and R2 S3 API keys on the service
 * (docs/cloudflare/r2.md). Without them it resolves to null: use downloadMedia() instead.
 */
export async function presignUrl(input: PresignUrlInput): Promise<string | null> {
  if (input.expiresInSeconds < 1 || input.expiresInSeconds > 604800) throw new TypeError('expiresInSeconds must be between 1 and 604800 (7 days, the R2 limit)');
  return presign(resolveService(input), input.renderId, input.expiresInSeconds);
}
