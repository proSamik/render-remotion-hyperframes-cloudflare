/**
 * One task in its own process: `node task-runner.ts <request.json> <result.json> <progress.json>`.
 * A fresh process per task keeps a crashed browser or a leak from reaching the next task, and it can be killed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Engine, RenderOptions, TaskRequest } from './types.ts';

const [requestFile, resultFile, progressFile] = process.argv.slice(2) as [string, string, string];
const request = JSON.parse(readFileSync(requestFile, 'utf8')) as { plan?: RenderOptions; task?: TaskRequest };

try {
  const enginePath = process.env.RENDER_ENGINE;
  if (!enginePath) throw new Error('RENDER_ENGINE is not set: it must point at the engine module of this image');
  const engine = (await import(pathToFileURL(enginePath).href)).default as Engine;
  let result: unknown;
  if (request.plan) result = { plan: await engine.plan(request.plan) };
  else {
    const task = request.task!;
    const dir = dirname(resultFile);
    let last = 0;
    const onProgress = (framesRendered: number) => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      try { writeFileSync(progressFile, JSON.stringify({ framesRendered })); } catch { /* progress is best effort */ }
    };
    result = { files: task.kind === 'stitch' ? await engine.stitch({ task, dir }) : await engine.render({ task, dir, onProgress }) };
  }
  writeFileSync(resultFile, JSON.stringify(result));
  process.exit(0);
} catch (error) {
  writeFileSync(resultFile, JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 4000) : String(error) }));
  process.exit(1);
}
