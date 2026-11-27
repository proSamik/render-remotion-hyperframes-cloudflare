import { getProgress } from '../../../core/src/client.ts';
import type { RenderProgress } from '../../../core/src/types.ts';
import { resolveService } from './service.ts';
import type { ServiceInput } from './types.ts';

export type GetRenderProgressInput = ServiceInput & { renderId: string };

/** The state of a render: overallProgress (0 to 1), done, framesRendered, chunks, errors, fatalErrorEncountered, costs, outputFile. */
export async function getRenderProgress(input: GetRenderProgressInput): Promise<RenderProgress> {
  return getProgress(resolveService(input), input.renderId);
}
