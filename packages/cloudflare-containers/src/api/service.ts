import { serviceFrom, type Service } from '../../../core/src/client.ts';
import type { ServiceInput } from './types.ts';

export function resolveService(input: ServiceInput): Service {
  return serviceFrom({
    serviceUrl: input.serviceUrl ?? process.env.REMOTION_CLOUDFLARE_SERVICE_URL ?? process.env.RENDER_SERVICE_URL,
    secret: input.secret ?? process.env.REMOTION_CLOUDFLARE_SECRET ?? process.env.RENDER_SECRET,
  });
}
