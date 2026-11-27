/**
 * Engine-neutral command line. The HyperFrames example uses it directly; the Remotion package wraps the same calls.
 *
 *   node packages/core/bin/render.mjs local  --engine <engine.ts> --render '<json>' --out out.mp4 [--docker <image>] [--instances N] [--frames-per-chunk N]
 *   node packages/core/bin/render.mjs cloud  --render '<json>' --out out.mp4 [--instances N] [--frames-per-chunk N]      (RENDER_SERVICE_URL, RENDER_SECRET)
 *   node packages/core/bin/render.mjs progress <renderId> | delete <renderId> | info
 */
import { resolve } from 'node:path';
import { deleteRender, downloadOutput, formatProgress, getProgress, getServiceInfo, serviceFrom, startRender, waitForRender } from './client.ts';
import { renderLocally } from './local.ts';
import type { FleetOptions, JobRequest, RenderProgress } from './types.ts';

export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const equals = token.indexOf('=');
    const key = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    const next = argv[index + 1];
    if (inline !== undefined) flags[key] = inline;
    else if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}
export function fleetFromFlags(flags: Record<string, string | true>): FleetOptions {
  const number = (name: string) => (typeof flags[name] === 'string' ? Number(flags[name]) : undefined);
  return {
    ...(number('instances') ?? number('concurrency') ? { instances: number('instances') ?? number('concurrency') } : {}),
    ...(number('processes-per-instance') ? { processesPerInstance: number('processes-per-instance') } : {}),
    ...(number('frames-per-chunk') ? { framesPerChunk: number('frames-per-chunk') } : {}),
    ...(number('max-retries') !== undefined ? { maxRetries: number('max-retries') } : {}),
  };
}
export function printer(quiet = false) {
  let last = '';
  return (progress: RenderProgress) => { const line = formatProgress(progress); const key = line.split('~')[0]!; if (!quiet && key !== last) { last = key; console.error(line); } };
}
export async function runLocal(request: JobRequest, flags: Record<string, string | true>, env: Record<string, string> = {}) {
  const out = String(flags.out ?? 'out/local.mp4');
  const result = await renderLocally({
    request, out, onProgress: printer(Boolean(flags.quiet)),
    fleet: { workDir: resolve(String(flags['work-dir'] ?? '.render-work')), env, ...(typeof flags.docker === 'string' ? { dockerImage: flags.docker, dockerArgs: typeof flags['docker-args'] === 'string' ? flags['docker-args'].split(' ').filter(Boolean) : [] } : { engine: resolve(String(flags.engine)) }) },
  });
  console.log(JSON.stringify({ out: result.out, frames: result.frames, chunks: result.chunks.total, seconds: (result.timeToFinish ?? 0) / 1000, sizeInBytes: result.outputSizeInBytes, errors: result.errors.map((error) => error.message) }, null, 2));
}
export async function runCloud(request: JobRequest, flags: Record<string, string | true>) {
  const service = serviceFrom({ ...(typeof flags['service-url'] === 'string' ? { serviceUrl: flags['service-url'] } : {}) });
  const { renderId } = await startRender(service, request);
  console.error(`render ${renderId} started`);
  const progress = await waitForRender(service, renderId, printer(Boolean(flags.quiet)));
  const out = String(flags.out ?? `out/${renderId}.${(progress.outputFile ?? 'out.mp4').split('.').pop()}`);
  const { sizeInBytes } = await downloadOutput(service, renderId, out, progress.outputSha256);
  if (!flags.keep) await deleteRender(service, renderId).catch(() => undefined);
  console.log(JSON.stringify({ renderId, out: resolve(out), sizeInBytes, frames: progress.frames, chunks: progress.chunks.total, seconds: (progress.timeToFinish ?? 0) / 1000, costs: progress.costs, errors: progress.errors.map((error) => error.message) }, null, 2));
}

export async function main(argv: string[]) {
  const { positional, flags } = parseFlags(argv);
  const [command, argument] = positional;
  const request = (): JobRequest => ({ render: JSON.parse(String(flags.render ?? '{}')), fleet: fleetFromFlags(flags) });
  try {
    if (command === 'local') await runLocal(request(), flags);
    else if (command === 'cloud') await runCloud(request(), flags);
    else if (command === 'progress' && argument) console.log(JSON.stringify(await getProgress(serviceFrom(), argument), null, 2));
    else if (command === 'delete' && argument) console.log(JSON.stringify(await deleteRender(serviceFrom(), argument)));
    else if (command === 'info') console.log(JSON.stringify(await getServiceInfo(serviceFrom()), null, 2));
    else { console.error('Usage: render.mjs <local|cloud|progress|delete|info> (see the header of packages/core/src/cli.ts)'); process.exitCode = 2; }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
