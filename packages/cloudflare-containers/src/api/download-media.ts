import { downloadOutput, getProgress } from '../../../core/src/client.ts';
import { resolveService } from './service.ts';
import type { ServiceInput } from './types.ts';

export type DownloadMediaInput = ServiceInput & { renderId: string; outPath: string };
export type DownloadMediaOutput = { outputPath: string; sizeInBytes: number };

/** Downloads a finished render through the service and checks the SHA-256 the instance computed. */
export async function downloadMedia(input: DownloadMediaInput): Promise<DownloadMediaOutput> {
  const service = resolveService(input);
  const progress = await getProgress(service, input.renderId);
  if (!progress.done) throw new Error(`Render ${input.renderId} is not finished (${Math.round(progress.overallProgress * 100)} %).`);
  const { outPath, sizeInBytes } = await downloadOutput(service, input.renderId, input.outPath, progress.outputSha256);
  return { outputPath: outPath, sizeInBytes };
}
