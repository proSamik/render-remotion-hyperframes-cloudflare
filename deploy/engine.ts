/**
 * The engine of the deployable service (../wrangler.jsonc): one image, three engines, picked per render by
 * `render.engine` ("remotion", "hyperframes" or "mixed"; default "remotion"). Each engine is loaded only when a task
 * needs it, in that task's own process.
 *
 *   remotion     the Remotion site bundled from examples/remotion-only (site "remotion")
 *   mixed        the site of examples/mixed (site "mixed"), with its HyperFrames layer
 *   hyperframes  the projects of examples/hyperframes-only (/app/projects: "composition", "long")
 *
 * To render your own code: replace the example folders' sources (or point the Dockerfile at yours) and deploy again.
 */
import type { Engine, RenderOptions } from '../packages/core/src/types.ts';

const SITES: Record<string, string> = { remotion: 'remotion', mixed: 'mixed' };
const loaded = new Map<string, Promise<Engine>>();

function engineFor(render: RenderOptions): Promise<Engine> {
  const name = String(render.engine ?? 'remotion');
  if (!['remotion', 'hyperframes', 'mixed'].includes(name)) throw new Error(`engine must be remotion, hyperframes or mixed (got ${JSON.stringify(name)})`);
  // A Remotion render names the site of its engine unless the request chose one.
  if (SITES[name] && render.serveUrl === undefined) render.serveUrl = SITES[name];
  if (!loaded.has(name)) {
    const module = name === 'hyperframes' ? import('../packages/hyperframes-engine/engine.ts') : name === 'mixed' ? import('../examples/mixed/engine.ts') : import('../packages/cloudflare-containers/container/engine.ts');
    loaded.set(name, module.then((imported) => imported.default as Engine));
  }
  return loaded.get(name)!;
}

const engine: Engine = {
  plan: async (render) => (await engineFor(render)).plan(render),
  render: async (input) => (await engineFor(input.task.render)).render(input),
  stitch: async (input) => (await engineFor(input.task.render)).stitch(input),
};
export default engine;
