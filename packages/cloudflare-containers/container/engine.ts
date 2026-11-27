/**
 * The Remotion engine: what runs inside a container for one task.
 *
 *   plan    selectComposition()
 *   render  renderMedia() for a whole video, or for one chunk using Remotion's distributed-rendering contract
 *           (https://www.remotion.dev/docs/distributed-rendering), or renderStill()
 *   stitch  combineChunks()
 *
 * `@remotion/renderer` is loaded from the project (REMOTION_PROJECT_DIR), so the version is the one your
 * composition was written and bundled with.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Engine, Plan, TaskRequest } from '../../core/src/types.ts';

/** Options of one render. Names follow renderMediaOnLambda() where the idea is the same. */
export type RemotionRenderOptions = {
  type?: 'media' | 'still';
  /** Inclusive, like renderMedia(). */
  frameRange?: [number, number] | null;
  /** A site baked into the image (`sites/<name>`, see deploySite()) or an https URL of a deployed bundle. */
  serveUrl?: string;
  composition?: string;
  inputProps?: Record<string, unknown>;
  codec?: 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores' | 'gif' | 'mp3' | 'aac' | 'wav';
  imageFormat?: 'jpeg' | 'png' | 'webp' | 'pdf' | 'none';
  jpegQuality?: number;
  scale?: number;
  crf?: number | null;
  videoBitrate?: string | null;
  audioBitrate?: string | null;
  x264Preset?: string;
  pixelFormat?: string;
  proResProfile?: string;
  colorSpace?: 'default' | 'bt709' | 'bt2020-ncl';
  muted?: boolean;
  everyNthFrame?: number;
  numberOfGifLoops?: number | null;
  envVariables?: Record<string, string>;
  timeoutInMilliseconds?: number;
  logLevel?: 'trace' | 'verbose' | 'info' | 'warn' | 'error';
  chromiumOptions?: { gl?: string | null; ignoreCertificateErrors?: boolean; disableWebSecurity?: boolean; headless?: boolean; userAgent?: string | null };
  /** Browser tabs per render process (Lambda: concurrencyPerLambda). Default 1 when an instance runs several processes. */
  concurrencyPerProcess?: number | null;
  /** The composition uses WebGL (three.js, shaders): true, or the frame ranges that do, as [[first, last], ...]. */
  webgl?: boolean | [number, number][];
  /** still */
  frame?: number;
};

type Hooks = {
  /** Runs before the browser opens, for plan and render. It may change `render.inputProps`. The mixed example pre-renders its HyperFrames layer here. */
  prepare?: (input: { siteDir: string | null; render: RemotionRenderOptions; phase: 'plan' | 'render' }) => Promise<void>;
};

const SITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const sitesDir = () => resolve(process.env.REMOTION_SITES_DIR ?? '/app/sites');

/** A site name becomes a folder in the image; an https URL is used as it is. Nothing else is accepted. */
export function resolveServeUrl(serveUrl: string | undefined): { serveUrl: string; siteDir: string | null } {
  if (serveUrl && /^https?:\/\//.test(serveUrl)) return { serveUrl, siteDir: null };
  const root = sitesDir();
  const name = serveUrl ?? process.env.REMOTION_DEFAULT_SITE ?? (existsSync(root) ? readdirSync(root).find((entry) => existsSync(join(root, entry, 'index.html'))) : undefined);
  if (!name || !SITE_NAME.test(name)) throw new Error(`serveUrl must be the name of a site in the image or an https URL (got ${JSON.stringify(serveUrl)})`);
  const siteDir = join(root, name);
  if (!existsSync(join(siteDir, 'index.html'))) throw new Error(`site "${name}" is not in this image (${root})`);
  return { serveUrl: siteDir, siteDir };
}

/**
 * A second browser for WebGL chunks. `angle-egl` (WebGL on Mesa llvmpipe) does not start in the Chromium build that
 * Remotion downloads (4.0.530 ships Chromium 149.0.7790.0: "Initialization of all (0) EGL display types failed").
 * It does start in Google's chrome-headless-shell builds. Point this variable at one and WebGL chunks use it.
 */
export const webglBrowser = () => {
  const path = process.env.REMOTION_WEBGL_BROWSER_EXECUTABLE;
  return path && existsSync(path) ? path : null;
};

/**
 * Which GL backend Chromium gets for a frame range. Measured on Cloudflare standard-4 (no GPU):
 *   no WebGL -> Remotion's default (no GL flag, CPU raster): `swangle` cost 1.7 to 5.5 times more there;
 *   WebGL    -> `angle-egl` on Mesa llvmpipe when a browser that supports it is installed (see webglBrowser()),
 *               otherwise `swangle` (SwiftShader), which is what Remotion documents for machines without a GPU.
 *               `angle` alone has no WebGL without a GPU.
 */
export function glFor(render: RemotionRenderOptions, startFrame: number, endFrame: number, platform = process.platform, eglBrowser: string | null = webglBrowser()): string | null {
  if (render.chromiumOptions?.gl !== undefined) return render.chromiumOptions.gl;
  const webgl = Array.isArray(render.webgl) ? render.webgl.some(([first, last]) => first < endFrame && last >= startFrame) : Boolean(render.webgl);
  if (!webgl) return null;
  if (platform !== 'linux') return 'angle';
  return eglBrowser ? 'angle-egl' : 'swangle';
}

export function createRemotionEngine(hooks: Hooks = {}): Engine {
  const projectRequire = createRequire(join(resolve(process.env.REMOTION_PROJECT_DIR ?? process.cwd()), 'package.json'));
  const renderer = () => projectRequire('@remotion/renderer') as typeof import('@remotion/renderer');

  async function open(render: RemotionRenderOptions, startFrame: number, endFrame: number, phase: 'plan' | 'render') {
    const { serveUrl, siteDir } = resolveServeUrl(render.serveUrl);
    await hooks.prepare?.({ siteDir, render, phase });
    const { ensureBrowser, openBrowser, selectComposition } = renderer();
    const logLevel = render.logLevel ?? 'error';
    const gl = glFor(render, startFrame, endFrame);
    const chromiumOptions = { ...render.chromiumOptions, gl: gl as any, enableMultiProcessOnLinux: true };
    const browserExecutable = gl === 'angle-egl' ? webglBrowser() : null;
    // Downloads Chrome Headless Shell on first use. In the image it is already there (see the Dockerfile).
    if (!browserExecutable) await ensureBrowser({ logLevel, chromeMode: 'headless-shell' });
    const browser = await openBrowser('chrome', { chromiumOptions, chromeMode: 'headless-shell', logLevel, browserExecutable });
    const shared = { serveUrl, inputProps: render.inputProps ?? {}, puppeteerInstance: browser, browserExecutable, chromiumOptions, chromeMode: 'headless-shell' as const, logLevel, envVariables: render.envVariables ?? {}, timeoutInMilliseconds: render.timeoutInMilliseconds ?? 120_000 };
    try {
      if (!render.composition) throw new Error('composition is required');
      const composition = await selectComposition({ ...shared, id: render.composition });
      return { browser, shared, composition };
    } catch (error) { await browser.close({ silent: true }).catch(() => undefined); throw error; }
  }

  return {
    async plan(options): Promise<Plan> {
      const render = options as RemotionRenderOptions;
      const { browser, composition } = await open(render, 0, 1, 'plan');
      await browser.close({ silent: true }).catch(() => undefined);
      // Only H.264 can be rendered in parts: a part is an MPEG-TS stream (`h264-ts`) that combineChunks() joins.
      return { fps: composition.fps, durationInFrames: composition.durationInFrames, width: composition.width, height: composition.height, chunkable: (render.codec ?? 'h264') === 'h264' };
    },

    async render({ task, dir, onProgress }): Promise<string[]> {
      const render = task.render as RemotionRenderOptions;
      const startFrame = task.startFrame ?? 0;
      const endFrame = task.endFrame ?? startFrame + 1;
      const { browser, shared, composition } = await open(render, startFrame, endFrame, 'render');
      try {
        if (task.kind === 'still') {
          const format = render.imageFormat === 'jpeg' || render.imageFormat === 'webp' || render.imageFormat === 'pdf' ? render.imageFormat : 'png';
          const name = `out.${format === 'jpeg' ? 'jpg' : format}`;
          await renderer().renderStill({ ...shared, composition, frame: startFrame, output: join(dir, name), imageFormat: format, scale: render.scale ?? 1, ...(format === 'jpeg' ? { jpegQuality: render.jpegQuality ?? 80 } : {}) });
          return [name];
        }
        const chunk = task.kind === 'chunk';
        const codec = render.codec ?? 'h264';
        const base = chunk ? `chunk-${String(task.chunkIndex ?? 0).padStart(4, '0')}` : 'out';
        const extension = chunk ? 'ts' : ({ h264: 'mp4', h265: 'mp4', vp8: 'webm', vp9: 'webm', prores: 'mov', gif: 'gif', mp3: 'mp3', aac: 'aac', wav: 'wav' } as Record<string, string>)[codec] ?? 'mp4';
        const video = `${base}.${extension}`;
        const audio = `${base}.aac`;
        const fps = composition.fps;
        await renderer().renderMedia({
          ...shared,
          composition,
          codec: chunk ? 'h264-ts' : codec,
          outputLocation: join(dir, video),
          frameRange: [startFrame, endFrame - 1],
          scale: render.scale ?? 1,
          // More tabs barely help; more processes do. With several processes on the instance each gets one tab.
          concurrency: render.concurrencyPerProcess ?? ((task.processes ?? 1) > 1 && chunk ? 1 : null),
          imageFormat: (render.imageFormat as 'jpeg' | 'png' | 'none' | undefined) ?? 'jpeg',
          ...(render.imageFormat === 'png' ? {} : { jpegQuality: render.jpegQuality ?? 80 }),
          ...(render.crf != null ? { crf: render.crf } : {}),
          ...(render.videoBitrate ? { videoBitrate: render.videoBitrate } : {}),
          ...(render.audioBitrate ? { audioBitrate: render.audioBitrate } : {}),
          ...(render.x264Preset ? { x264Preset: render.x264Preset as any } : {}),
          ...(render.pixelFormat ? { pixelFormat: render.pixelFormat as any } : {}),
          ...(render.proResProfile ? { proResProfile: render.proResProfile as any } : {}),
          ...(render.everyNthFrame ? { everyNthFrame: render.everyNthFrame } : {}),
          ...(render.numberOfGifLoops != null ? { numberOfGifLoops: render.numberOfGifLoops } : {}),
          colorSpace: render.colorSpace ?? 'bt709',
          muted: render.muted ?? false,
          ...(chunk ? {
            // The distributed-rendering contract. Every chunk gets the SAME compositionStart: the first frame of the
            // whole export. Remotion lays the AAC frames on a grid counted from there and renders a little extra
            // audio on both sides, which combineChunks() cuts away at the join.
            compositionStart: task.compositionStart ?? 0,
            forSeamlessAacConcatenation: true,
            separateAudioTo: join(dir, audio),
            audioCodec: 'aac' as const,
            enforceAudioTrack: true,
            // One closed GOP per second, the same in every chunk.
            gopSize: Math.round(fps),
          } : { enforceAudioTrack: !(render.muted ?? false) }),
          onProgress: (progress: { renderedFrames: number }) => onProgress(progress.renderedFrames),
        } as any);
        return chunk ? [video, audio] : [video];
      } finally { await browser.close({ silent: true }).catch(() => undefined); }
    },

    async stitch({ task, dir }): Promise<string[]> {
      const names = Array.from({ length: task.chunkCount ?? 0 }, (_, index) => `chunk-${String(index).padStart(4, '0')}`);
      const startFrame = task.startFrame ?? 0;
      const endFrame = task.endFrame ?? task.plan.durationInFrames;
      const whole = startFrame === 0 && endFrame === task.plan.durationInFrames;
      await renderer().combineChunks({
        outputLocation: join(dir, 'out.mp4'),
        videoFiles: names.map((name) => join(dir, `${name}.ts`)),
        audioFiles: names.map((name) => join(dir, `${name}.aac`)),
        codec: 'h264', audioCodec: 'aac', fps: task.plan.fps, framesPerChunk: task.framesPerChunk!,
        compositionDurationInFrames: task.plan.durationInFrames, frameRange: whole ? null : [startFrame, endFrame - 1],
        preferLossless: false, logLevel: 'error',
      } as any);
      return ['out.mp4'];
    },
  };
}

export default createRemotionEngine();
export type { TaskRequest };
