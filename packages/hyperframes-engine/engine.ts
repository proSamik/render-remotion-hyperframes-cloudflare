/**
 * The HyperFrames engine: one task = one run of HyperFrames' own renderer (`hyperframes render`), which drives
 * headless Chrome and FFmpeg itself. Nothing of Remotion is involved.
 *
 * It does not split a video into chunks. `hyperframes render` parallelises inside one machine (`--workers`), and
 * that is what one container instance gives you. Distributed HyperFrames rendering exists upstream as
 * `@hyperframes/producer/distributed` (plan / renderChunk / assemble, used by `hyperframes lambda` and
 * `hyperframes cloudrun`); wiring that into this coordinator is not done here. See docs/chunking.md.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Engine, Plan } from '../core/src/types.ts';

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
};

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

/** Runs `hyperframes render`. `cliFrom` is a folder whose node_modules holds the pinned `hyperframes` package. */
export function renderHyperframes(input: { projectDir: string; out: string; options: HyperframesRenderOptions; cliFrom: string; onProgress?: (fraction: number) => void }): Promise<void> {
  const { options } = input;
  const cli = join(dirname(createRequire(join(resolve(input.cliFrom), 'package.json')).resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');
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
  return {
    async plan(render) {
      const options = render as HyperframesRenderOptions;
      return readComposition(projectDirOf(options), options.fps ?? 30);
    },
    async render({ task, dir, onProgress }) {
      const options = task.render as HyperframesRenderOptions;
      const name = `out.${options.format ?? 'mp4'}`;
      await renderHyperframes({ projectDir: projectDirOf(options), out: join(dir, name), options, cliFrom, onProgress: (fraction) => onProgress(Math.round(fraction * task.plan.durationInFrames)) });
      return [name];
    },
    async stitch() { throw new Error('the HyperFrames engine renders a video in one piece: there is nothing to stitch'); },
  };
}

export default createHyperframesEngine();
