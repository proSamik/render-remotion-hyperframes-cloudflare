import { downloadOutput, startRender, waitForRender } from '../../../core/src/client.ts';
import { toJobRequest } from './render-media-on-cloudflare.ts';
import { resolveService } from './service.ts';
import type { RenderMediaOnCloudflareInput } from './types.ts';

export type RenderStillOnCloudflareInput = Omit<RenderMediaOnCloudflareInput, 'codec' | 'concurrency' | 'framesPerChunk' | 'processesPerInstance'> & {
  frame?: number;
  imageFormat?: 'png' | 'jpeg' | 'webp' | 'pdf';
  /** Save the image here when it is done. */
  outPath?: string;
};
export type RenderStillOnCloudflareOutput = { renderId: string; outputUrl: string; sizeInBytes: number; estimatedPrice: { accruedSoFar: number; currency: 'USD' }; outputPath: string | null };

/** Renders one frame and waits for it. The counterpart of renderStillOnLambda(). */
export async function renderStillOnCloudflare(input: RenderStillOnCloudflareInput): Promise<RenderStillOnCloudflareOutput> {
  const service = resolveService(input);
  const { outPath, frame, ...rest } = input;
  const request = toJobRequest(rest as RenderMediaOnCloudflareInput, 'still');
  request.render.frame = frame ?? 0;
  const { renderId } = await startRender(service, request);
  const progress = await waitForRender(service, renderId, undefined, 1000);
  const outputPath = outPath ? (await downloadOutput(service, renderId, outPath, progress.outputSha256)).outPath : null;
  return { renderId, outputUrl: `${service.serviceUrl}/renders/${renderId}/output`, sizeInBytes: progress.outputSizeInBytes ?? 0, estimatedPrice: { accruedSoFar: progress.costs.accruedSoFar, currency: 'USD' }, outputPath };
}
