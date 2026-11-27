import { getServiceInfo as info } from '../../../core/src/client.ts';
import { resolveService } from './service.ts';
import type { ServiceInput } from './types.ts';

/** Asks a deployed service what it is: name, instance type, whether R2 is attached, instances allowed per render. */
export async function getServiceInfo(input: ServiceInput = {}) {
  const service = resolveService(input);
  return { serviceUrl: service.serviceUrl, ...(await info(service)) };
}
