/**
 * Renders the layer with its default variables into `<dir>/hf/`: node ... prerender-layer.ts <public dir>
 * Used by `npm run layer` (for Studio and for the site) and by the Dockerfile (so the image starts with a warm cache).
 */
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureLayer } from './layer.ts';

const publicDir = resolve(process.argv[3] ?? process.argv[2] ?? 'public');
const started = Date.now();
const name = await ensureLayer(publicDir);
copyFileSync(join(publicDir, name), join(publicDir, 'hf/layer-default.webm'));
console.log(`${name} ready in ${((Date.now() - started) / 1000).toFixed(1)} s (also as hf/layer-default.webm)`);
