import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export type DeployServiceInput = {
  /** Folder with the service's wrangler.jsonc and Dockerfile (an example folder of this repository, or your copy of one). */
  cwd: string;
  /** Extra arguments for `wrangler deploy`, for example ['--dry-run']. */
  wranglerArgs?: string[];
  onLog?: (line: string) => void;
};
export type DeployServiceOutput = { serviceUrl: string | null; output: string };

/**
 * Deploys the Worker and builds and pushes the container image: it runs `wrangler deploy` in `cwd`.
 * Wrangler needs a running Docker to build the image, and `wrangler login` (or CLOUDFLARE_API_TOKEN) done before.
 * The counterpart of deployFunction() / deployService(). The service is yours: its name, instance type and secrets
 * are in the wrangler.jsonc you deploy, not chosen by this function.
 */
export async function deployService(input: DeployServiceInput): Promise<DeployServiceOutput> {
  const cwd = resolve(input.cwd);
  if (!['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((name) => existsSync(join(cwd, name)))) throw new Error(`No wrangler configuration in ${cwd}`);
  const wrangler = join(dirname(createRequire(join(cwd, 'package.json')).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  const output = await new Promise<string>((done, failed) => {
    const child = spawn(process.execPath, [wrangler, 'deploy', ...(input.wranglerArgs ?? [])], { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    let text = '';
    const take = (data: Buffer) => { text += data; for (const line of String(data).split('\n')) if (line.trim()) input.onLog?.(line); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', failed);
    child.once('close', (code) => (code === 0 ? done(text) : failed(new Error(`wrangler deploy ended with code ${code}\n${text.slice(-3000)}`))));
  });
  return { serviceUrl: /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] ?? null, output };
}
