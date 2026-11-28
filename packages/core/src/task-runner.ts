/**
 * One task in its own process: `node task-runner.ts <request.json> <result.json> <progress.json>`.
 * A fresh process per task keeps a crashed browser or a leak from reaching the next task, and it can be killed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChunkFeed } from './chunk-feed.ts';
import { putStream } from './transfer.ts';
import type { Engine, FileInfo, RenderOptions, StreamOutput, TaskRequest } from './types.ts';

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
    if (task.kind !== 'stitch') result = { files: await engine.render({ task, dir, onProgress }) };
    else if ((task.stitch ?? 'combine') === 'combine') result = { files: await engine.stitch({ task, dir }) };
    else {
      // Streaming join: the chunks arrive while the engine joins them. With 'stream-fmp4' and object storage the output
      // leaves through the same door: the engine writes into `output`, and the file never exists on this disk.
      const feed = createChunkFeed({ dir, chunks: (task.chunks ?? []).map((chunk) => ({ index: chunk.index, files: chunk.files.map((file) => ({ ...file, ...(task.download?.[file.name] ? { url: task.download[file.name] } : {}) })) })) });
      const target = task.stitch === 'stream-fmp4' ? task.upload?.['*'] : undefined;
      let uploaded: FileInfo | undefined;
      const output: StreamOutput | undefined = target ? { name: 'out.mp4', write: async (stream) => { uploaded = await putStream(target, stream, 'out.mp4'); } } : undefined;
      try { result = { files: await engine.stitch({ task, dir, chunks: feed, ...(output ? { output } : {}) }), ...(uploaded ? { uploaded: [uploaded] } : {}) }; }
      finally { feed.close(); }
    }
  }
  writeFileSync(resultFile, JSON.stringify(result));
  process.exit(0);
} catch (error) {
  writeFileSync(resultFile, JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 4000) : String(error) }));
  process.exit(1);
}
