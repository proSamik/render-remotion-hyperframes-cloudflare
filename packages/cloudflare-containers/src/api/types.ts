import type { RemotionRenderOptions } from '../../container/engine.ts';

/** Where the service is and how to authenticate. Falls back to REMOTION_CLOUDFLARE_SERVICE_URL / REMOTION_CLOUDFLARE_SECRET, then RENDER_SERVICE_URL / RENDER_SECRET. */
export type ServiceInput = { serviceUrl?: string; secret?: string };

/** Options shared by renderMediaOnCloudflare() and the CLI. The render options keep Remotion's names. */
export type RenderMediaOnCloudflareInput = ServiceInput & Omit<RemotionRenderOptions, 'type' | 'frame'> & {
  composition: string;
  /** A site baked into the service image (see deploySite()) or the https URL of any deployed Remotion bundle. Default: the image's only site. */
  serveUrl?: string;
  /** How many container instances render this video (Lambda: `concurrency`). Default 1. */
  concurrency?: number;
  /** Render processes per instance, one tab each. Default 3; use 2 for WebGL content. */
  processesPerInstance?: number;
  /** Frames per chunk (Lambda: `framesPerLambda`). Default: frames / (concurrency * processesPerInstance), at least 30. */
  framesPerChunk?: number | null;
  /** Extra attempts per chunk (Lambda: `maxRetries`). Default 2. */
  maxRetries?: number;
  /** Seconds before a running chunk is abandoned and rendered again on a fresh instance. */
  chunkDeadlineInSeconds?: number | null;
  /** A second run for a chunk that is measurably slow, when a slot is free. Default true. */
  duplicateStragglers?: boolean;
  /** At most this share of the chunks gets a second run, rounded up. Default 0.05. */
  maxHedgeShare?: number;
  /** How chunks are joined: 'combine' (combineChunks(), default), 'stream' or 'stream-fmp4' (docs/long-videos.md). */
  stitch?: 'combine' | 'stream' | 'stream-fmp4';
};
export type RenderMediaOnCloudflareOutput = { renderId: string; serviceUrl: string; progressUrl: string; outputUrl: string };
