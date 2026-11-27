import { deleteRender as remove } from '../../../core/src/client.ts';
import { resolveService } from './service.ts';
import type { ServiceInput } from './types.ts';

/** Stops every instance of a render (cancelling it if it is still running) and deletes its files. */
export async function deleteRender(input: ServiceInput & { renderId: string }): Promise<{ deleted: string }> {
  return remove(resolveService(input), input.renderId);
}
