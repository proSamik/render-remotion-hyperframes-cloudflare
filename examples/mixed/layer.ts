/**
 * The HyperFrames layer of the mixed example, as a cached file.
 *
 * The layer is rendered once by HyperFrames into a WebM with an alpha channel (VP9), named after a hash of
 * everything that can change its pixels: the layer's source files, its variables, the frame rate and the HyperFrames
 * version. Same inputs, same name, no second render. Different variables give a different file, so two jobs with
 * different text never see each other's layer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHyperframes } from '../../packages/hyperframes-engine/engine.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const layerDir = () => resolve(process.env.MIXED_LAYER_DIR ?? join(here, 'hyperframes-layer'));
const cliFrom = () => resolve(process.env.HYPERFRAMES_CLI_DIR ?? here);

function filesOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.name.startsWith('.') ? [] : entry.isDirectory() ? filesOf(join(dir, entry.name)) : [join(dir, entry.name)])).sort();
}

export function layerName(variables: Record<string, unknown> = {}, fps = 30): string {
  const hash = createHash('sha256');
  const dir = layerDir();
  for (const file of filesOf(dir)) hash.update(relative(dir, file)).update(readFileSync(file));
  const version = createRequire(join(cliFrom(), 'package.json'))('hyperframes/package.json').version as string;
  hash.update(JSON.stringify({ variables, fps, version }));
  return `hf/layer-${hash.digest('hex').slice(0, 16)}.webm`;
}

/** Makes sure the layer file exists under `publicDir` and returns its name relative to it (for staticFile()). */
export async function ensureLayer(publicDir: string, variables: Record<string, unknown> = {}, fps = 30): Promise<string> {
  const name = layerName(variables, fps);
  const file = join(publicDir, name);
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  // Several render processes start at once on one instance: the first renders the layer, the others wait for it.
  for (let waited = 0; !existsSync(file); waited += 1) {
    try { mkdirSync(lock); } catch {
      if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 15 * 60_000) rmSync(lock, { recursive: true, force: true });
      if (waited > 1800) throw new Error('waited 15 minutes for the HyperFrames layer');
      await new Promise((done) => setTimeout(done, 500));
      continue;
    }
    try {
      const temporary = join(dirname(file), `.tmp-${process.pid}.webm`);
      await renderHyperframes({ projectDir: layerDir(), out: temporary, cliFrom: cliFrom(), options: { format: 'webm', fps, quality: 'standard', ...(Object.keys(variables).length ? { variables } : {}) } });
      renameSync(temporary, file); // appears complete or not at all
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  return name;
}
