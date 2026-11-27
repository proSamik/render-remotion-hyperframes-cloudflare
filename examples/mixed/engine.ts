/**
 * Engine of the mixed example: the Remotion engine, plus one step before each render that makes sure the
 * HyperFrames layer exists in the site's public folder and tells the composition its file name.
 */
import { join } from 'node:path';
import { createRemotionEngine } from '../../packages/cloudflare-containers/container/engine.ts';
import { ensureLayer, layerName } from './layer.ts';

export default createRemotionEngine({
  async prepare({ siteDir, render, phase }) {
    if (!siteDir) throw new Error('the mixed example needs a site baked into the image: the layer is written into its public folder');
    const variables = (render.inputProps?.layerVariables ?? {}) as Record<string, unknown>;
    // Planning only needs the name. Rendering needs the file: a cache hit when the image already holds it
    // (the Dockerfile pre-renders the default layer), otherwise one HyperFrames render per instance.
    const name = phase === 'plan' ? layerName(variables) : await ensureLayer(join(siteDir, 'public'), variables);
    render.inputProps = { ...render.inputProps, hyperframesLayer: name };
  },
});
