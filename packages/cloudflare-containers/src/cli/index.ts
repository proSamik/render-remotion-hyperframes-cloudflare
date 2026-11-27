/**
 * remotion-cloudflare: the command line of this package. Subcommands follow `npx remotion lambda`.
 *
 *   sites create <entry-point> [--site-name=site] [--sites-dir=build/sites]
 *   services deploy [--cwd=.]            wrangler deploy: Worker + container image
 *   services info                        asks the deployed service what it is
 *   render <composition> [flags]         starts a render, shows progress, downloads the result
 *   still <composition> [--frame=0]
 *   progress <render-id>                 one JSON document
 *   rm <render-id>                       cancels a render and deletes its files
 *   doctor                               checks this machine and the service
 *
 * render/still flags: --serve-url --props='<json or file>' --codec --frames=0-299 --scale --jpeg-quality --crf
 *   --video-bitrate --x264-preset --image-format --muted --gl=<angle-egl|swangle|...> --webgl --out=<file>
 *   --concurrency=<instances> --processes-per-instance --frames-per-chunk --max-retries --concurrency-per-process --keep
 * Where to render: the service from --service-url / REMOTION_CLOUDFLARE_SERVICE_URL (secret: REMOTION_CLOUDFLARE_SECRET),
 *   or --local (processes on this machine), or --docker=<image> (containers on this machine).
 *   Local flags: --engine=<engine.ts> --sites-dir=build/sites --project-dir=.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetFromFlags, parseFlags, runCloud, runLocal } from '../../../core/src/cli.ts';
import { deleteRender } from '../api/delete-render.ts';
import { deployService } from '../api/deploy-service.ts';
import { deploySite } from '../api/deploy-site.ts';
import { getRenderProgress } from '../api/get-render-progress.ts';
import { getServiceInfo } from '../api/get-service-info.ts';
import { toJobRequest } from '../api/render-media-on-cloudflare.ts';
import { resolveService } from '../api/service.ts';
import type { RenderMediaOnCloudflareInput } from '../api/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
let positional: string[] = [];
let flags: Record<string, string | true> = {};
const text = (name: string) => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined);
const number = (name: string) => (text(name) === undefined ? undefined : Number(text(name)));

function renderInput(composition: string): RenderMediaOnCloudflareInput {
  const props = text('props');
  const inputProps = props ? JSON.parse(existsSync(props) ? readFileSync(props, 'utf8') : props) : undefined;
  const frames = text('frames')?.split('-').map(Number);
  return {
    composition,
    ...(text('serve-url') ? { serveUrl: text('serve-url') } : {}),
    ...(inputProps ? { inputProps } : {}),
    ...(text('codec') ? { codec: text('codec') as any } : {}),
    ...(frames ? { frameRange: [frames[0]!, frames[1] ?? frames[0]!] as [number, number] } : {}),
    ...(number('scale') ? { scale: number('scale') } : {}),
    ...(number('jpeg-quality') ? { jpegQuality: number('jpeg-quality') } : {}),
    ...(number('crf') !== undefined ? { crf: number('crf') } : {}),
    ...(text('video-bitrate') ? { videoBitrate: text('video-bitrate') } : {}),
    ...(text('x264-preset') ? { x264Preset: text('x264-preset') } : {}),
    ...(text('image-format') ? { imageFormat: text('image-format') as any } : {}),
    ...(flags.muted ? { muted: true } : {}),
    ...(text('gl') ? { chromiumOptions: { gl: text('gl')! } } : {}),
    ...(flags.webgl ? { webgl: true } : {}),
    ...(number('concurrency-per-process') ? { concurrencyPerProcess: number('concurrency-per-process') } : {}),
    ...(number('timeout') ? { timeoutInMilliseconds: number('timeout') } : {}),
  };
}

async function render(type: 'media' | 'still') {
  const composition = positional[1];
  if (!composition) throw new Error(`Usage: remotion-cloudflare ${positional[0]} <composition> [flags]`);
  const request = toJobRequest(renderInput(composition), type);
  if (type === 'still') request.render.frame = number('frame') ?? 0;
  request.fleet = { ...request.fleet, ...fleetFromFlags(flags) };
  flags.out ??= type === 'still' ? `out/${composition}.png` : `out/${composition}.mp4`;
  if (flags.local || text('docker')) {
    const projectDir = resolve(text('project-dir') ?? '.');
    flags.engine ??= join(here, '../../container/engine.ts');
    return runLocal(request, flags, { REMOTION_SITES_DIR: resolve(text('sites-dir') ?? join(projectDir, 'build/sites')), REMOTION_PROJECT_DIR: projectDir });
  }
  const service = resolveService({ ...(text('service-url') ? { serviceUrl: text('service-url') } : {}) });
  process.env.RENDER_SERVICE_URL = service.serviceUrl;
  process.env.RENDER_SECRET = service.secret;
  return runCloud(request, flags);
}

function doctor() {
  const check = (name: string, ok: boolean, hint: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${hint}`}`); return ok; };
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  let good = check(`Node ${process.versions.node}`, major > 22 || (major === 22 && minor >= 18), 'Node 22.18 or newer is needed (TypeScript files run directly)');
  good = check('Docker daemon (to build the image and for --docker)', spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0, 'start Docker, or build the image elsewhere (docs/daemonless-deploy.md)') && good;
  // `wrangler whoami` prints the account e-mail: its output is discarded, only the exit status is used.
  const wrangler = spawnSync('npx', ['--no-install', 'wrangler', 'whoami'], { stdio: 'ignore' });
  good = check('wrangler logged in', wrangler.status === 0, 'run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN)') && good;
  return good;
}

export async function main(argv: string[]) {
  ({ positional, flags } = parseFlags(argv));
  try {
    const [command, sub] = positional;
    if (command === 'sites' && sub === 'create') {
      if (!positional[2]) throw new Error('Usage: remotion-cloudflare sites create <entry-point> [--site-name=site]');
      let shown = -1;
      const result = await deploySite({ entryPoint: positional[2], ...(text('site-name') ? { siteName: text('site-name') } : {}), ...(text('sites-dir') ? { sitesDir: text('sites-dir') } : {}),
        options: { onBundleProgress: (progress) => { if (progress >= shown + 25) { shown = progress; console.error(`bundling ${progress} %`); } } } });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'services' && sub === 'deploy') {
      const result = await deployService({ cwd: text('cwd') ?? '.', onLog: (line) => console.error(line) });
      console.log(JSON.stringify({ serviceUrl: result.serviceUrl }, null, 2));
    } else if (command === 'services' && sub === 'info') console.log(JSON.stringify(await getServiceInfo({}), null, 2));
    else if (command === 'render') await render('media');
    else if (command === 'still') await render('still');
    else if (command === 'progress' && sub) console.log(JSON.stringify(await getRenderProgress({ renderId: sub }), null, 2));
    else if (command === 'rm' && sub) console.log(JSON.stringify(await deleteRender({ renderId: sub })));
    else if (command === 'doctor') {
      let good = doctor();
      try { const info = await getServiceInfo({}); console.log(`ok   service ${info.service} at ${info.serviceUrl} (${info.instanceType}, R2 ${info.storage ? 'attached' : 'not attached'})`); }
      catch (error) { console.log(`--   no service checked: ${error instanceof Error ? error.message.split('\n')[0] : error}`); }
      process.exitCode = good ? 0 : 1;
    } else { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]!.split('\n').slice(1).map((line) => line.replace(/^ \* ?/, '')).join('\n')); process.exitCode = 2; }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
