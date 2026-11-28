/**
 * The HyperFrames engine. Two ways to render, picked per job:
 *
 *   split (default for MP4)  the video is cut into frame ranges that render on any instance and join without a
 *                            re-encode: HyperFrames' own distributed primitives (`@hyperframes/producer/distributed`)
 *                            per range, MPEG-TS with timestamps on the timeline, one audio mix for the whole video.
 *                            See split.ts and docs/hyperframes-split.md.
 *   cli                      one run of `hyperframes render` for the whole video on one instance (`"split": false`,
 *                            and every format other than MP4: WebM and MOV with alpha, GIF, ...).
 *
 * Nothing of Remotion is involved.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Engine, Plan } from '../core/src/types.ts';
import { segmentsFromHtml } from './ranges.ts';
import { ensureBrowser, loadDistributed, renderSplitChunk, renderSplitSingle, sizeFor, stitchSplit, type SplitOptions } from './split.ts';

export type HyperframesRenderOptions = {
  /** Name of a project folder under HYPERFRAMES_PROJECTS_DIR (in the image: /app/projects). Default: the only one, or "composition". */
  project?: string;
  fps?: number;
  quality?: 'draft' | 'looks' | 'standard' | 'high' | 'delivery';
  /** mp4 (default); webm and mov carry an alpha channel when the composition's background is transparent. */
  format?: 'mp4' | 'webm' | 'mov';
  workers?: number | 'auto';
  /** Values for the composition's `data-composition-variables`. */
  variables?: Record<string, unknown>;
  /** false: always one `hyperframes render` on one instance. Default: split rendering for MP4. */
  split?: boolean;
  /** Split rendering only: output size, a name of packages/core/src/resolution.ts ("480p", "1080p", "4k") or "composition". */
  resolution?: string;
  /** Split rendering only: x264 CRF instead of the quality's own. */
  crf?: number;
  /** Split rendering only: longest gap between keyframes in seconds (default 2); every chunk also starts with one. */
  keyframeIntervalSeconds?: number;
};

/** Split rendering applies: MP4 and not switched off. */
export const splits = (options: HyperframesRenderOptions) => options.split !== false && (options.format ?? 'mp4') === 'mp4';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function projectDirOf(options: HyperframesRenderOptions): string {
  const name = options.project ?? 'composition';
  if (!NAME.test(name)) throw new Error(`project must be a folder name (got ${JSON.stringify(name)})`);
  const dir = join(resolve(process.env.HYPERFRAMES_PROJECTS_DIR ?? '/app/projects'), name);
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`no HyperFrames project "${name}" in this image (${dir})`);
  return dir;
}

/** Size and length come from the root element's data attributes: no browser is needed to plan. */
export function readComposition(projectDir: string, fps = 30): Plan {
  const html = readFileSync(join(projectDir, 'index.html'), 'utf8');
  const root = /<[^>]*data-composition-id=[^>]*>/s.exec(html)?.[0] ?? '';
  const attribute = (name: string) => Number(new RegExp(`${name}="([^"]+)"`).exec(root)?.[1]);
  const [width, height, seconds] = [attribute('data-width'), attribute('data-height'), attribute('data-duration')];
  if (!width || !height || !seconds) throw new Error('the root element needs data-width, data-height and data-duration');
  return { fps, width, height, durationInFrames: Math.round(seconds * fps), chunkable: false };
}

/** The plan the coordinator works with. Split: chunkable, two files per chunk, any chunk lengths, heavy ranges from the HTML. */
export function planOf(projectDir: string, options: HyperframesRenderOptions): Plan {
  const plan = readComposition(projectDir, options.fps ?? 30);
  if (!splits(options)) return plan;
  if (!Number.isInteger(plan.fps)) throw new Error('split rendering needs a whole-number frame rate; pass "split": false for 29.97 and the like');
  const size = sizeFor(plan.width, plan.height, options.resolution);
  const html = readFileSync(join(projectDir, 'index.html'), 'utf8');
  return { ...plan, width: size.width, height: size.height, chunkable: true, chunkFiles: ['.ts', '.json'], variableChunks: true, segments: segmentsFromHtml(html, plan.fps, plan.durationInFrames) };
}

/** The `hyperframes` CLI script in the node_modules of `cliFrom`. */
export const cliOf = (cliFrom: string) => join(dirname(createRequire(join(resolve(cliFrom), 'package.json')).resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');

/** Runs `hyperframes render`. `cliFrom` is a folder whose node_modules holds the pinned `hyperframes` package. */
export function renderHyperframes(input: { projectDir: string; out: string; options: HyperframesRenderOptions; cliFrom: string; onProgress?: (fraction: number) => void }): Promise<void> {
  const { options } = input;
  const cli = cliOf(input.cliFrom);
  const args = [cli, 'render', input.projectDir, '--output', input.out, '--fps', String(options.fps ?? 30), '--quality', options.quality ?? 'looks', '--format', options.format ?? 'mp4',
    ...(options.workers ? ['--workers', String(options.workers)] : []), ...(options.variables ? ['--variables', JSON.stringify(options.variables)] : [])];
  return new Promise((done, failed) => {
    // No telemetry from a render service, and no Chrome sandbox: like every container, this one has no user namespaces for it.
    const child = spawn(process.execPath, args, { env: { ...process.env, HYPERFRAMES_TELEMETRY: '0', DO_NOT_TRACK: '1', HYPERFRAMES_CHROME_SANDBOX: process.platform === 'linux' ? '0' : (process.env.HYPERFRAMES_CHROME_SANDBOX ?? ''), CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (data: Buffer) => {
      const text = String(data);
      tail = (tail + text).slice(-4000);
      // The CLI reports its stages as `@hf-progress {"code":"...","pct":N}` lines.
      for (const match of text.matchAll(/@hf-progress (\{[^\n]*\})/g)) { try { input.onProgress?.(Number(JSON.parse(match[1]!).pct) / 100); } catch { /* not a progress line */ } }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', failed);
    child.once('close', (code) => (code === 0 && existsSync(input.out) ? done() : failed(new Error(`hyperframes render ended with code ${code}: ${tail.slice(-1500)}`))));
  });
}

export function createHyperframesEngine(): Engine {
  const cliFrom = process.env.HYPERFRAMES_CLI_DIR ?? process.cwd();
  const split = (options: HyperframesRenderOptions) => {
    const projectDir = projectDirOf(options);
    const composition = readComposition(projectDir, options.fps ?? 30);
    const splitOptions: SplitOptions = { ...(options.quality ? { quality: options.quality } : {}), ...(options.variables ? { variables: options.variables } : {}), ...(options.resolution ? { resolution: options.resolution } : {}), ...(options.keyframeIntervalSeconds ? { keyframeIntervalSeconds: options.keyframeIntervalSeconds } : {}), ...(options.crf !== undefined ? { crf: options.crf } : {}), ...(options.workers ? { workers: options.workers } : {}) };
    return { projectDir, composition: { fps: composition.fps, width: composition.width, height: composition.height }, options: splitOptions, prepare: () => ensureBrowser(cliOf(cliFrom)) };
  };
  return {
    async plan(render) {
      const options = render as HyperframesRenderOptions;
      return planOf(projectDirOf(options), options);
    },
    async render({ task, dir, onProgress }) {
      const options = task.render as HyperframesRenderOptions;
      if (splits(options)) {
        const api = await loadDistributed(cliFrom);
        return task.kind === 'chunk' ? renderSplitChunk({ api, task, dir, onProgress, ...split(options) }) : renderSplitSingle({ api, task, dir, onProgress, ...split(options) });
      }
      const name = `out.${options.format ?? 'mp4'}`;
      await renderHyperframes({ projectDir: projectDirOf(options), out: join(dir, name), options, cliFrom, onProgress: (fraction) => onProgress(Math.round(fraction * task.plan.durationInFrames)) });
      return [name];
    },
    async stitch({ task, dir, chunks, output }) {
      const options = task.render as HyperframesRenderOptions;
      if (!splits(options)) throw new Error('this HyperFrames render was not split: there is nothing to stitch');
      return stitchSplit({ api: await loadDistributed(cliFrom), task, dir, ...split(options), ...(chunks ? { feed: chunks } : {}), ...(output ? { output } : {}) });
    },
  };
}

export default createHyperframesEngine();
