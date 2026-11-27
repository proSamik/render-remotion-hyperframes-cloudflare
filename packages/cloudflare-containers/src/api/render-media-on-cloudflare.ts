import { startRender } from '../../../core/src/client.ts';
import type { JobRequest } from '../../../core/src/types.ts';
import { resolveService } from './service.ts';
import type { RenderMediaOnCloudflareInput, RenderMediaOnCloudflareOutput } from './types.ts';

/** Splits the input into what the engine gets (`render`) and what the coordinator gets (`fleet`). */
export function toJobRequest(input: RenderMediaOnCloudflareInput, type: 'media' | 'still' = 'media'): JobRequest {
  const { serviceUrl: _url, secret: _secret, concurrency, processesPerInstance, framesPerChunk, maxRetries, chunkDeadlineInSeconds, duplicateStragglers, ...render } = input;
  // Input props travel as JSON in the request body. They are not uploaded to a bucket first, as Lambda does above 200 kB.
  JSON.stringify(render.inputProps ?? {});
  return {
    render: { ...render, type } as JobRequest['render'],
    fleet: {
      ...(concurrency ? { instances: concurrency } : {}), ...(processesPerInstance ? { processesPerInstance } : {}), ...(framesPerChunk ? { framesPerChunk } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}), ...(chunkDeadlineInSeconds ? { chunkDeadlineSeconds: chunkDeadlineInSeconds } : {}), ...(duplicateStragglers !== undefined ? { duplicateStragglers } : {}),
    },
  };
}

/**
 * Starts a render on your Cloudflare render service and returns at once. Poll getRenderProgress() with the renderId.
 * The counterpart of renderMediaOnLambda().
 */
export async function renderMediaOnCloudflare(input: RenderMediaOnCloudflareInput): Promise<RenderMediaOnCloudflareOutput> {
  const service = resolveService(input);
  const { renderId } = await startRender(service, toJobRequest(input));
  return { renderId, serviceUrl: service.serviceUrl, progressUrl: `${service.serviceUrl}/renders/${renderId}`, outputUrl: `${service.serviceUrl}/renders/${renderId}/output` };
}
