import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export type DeploySiteInput = {
  /** The file that calls registerRoot(). */
  entryPoint: string;
  /** Name of the site. Default "site". Letters, digits, dot, dash, underscore. */
  siteName?: string;
  /** Folder that holds the sites of a service; the service's Dockerfile copies it into the image. Default: `<project>/build/sites`. */
  sitesDir?: string;
  options?: { publicDir?: string | null; rootDir?: string; webpackOverride?: (config: any) => any; onBundleProgress?: (progress: number) => void; enableCaching?: boolean };
};
export type DeploySiteOutput = { siteName: string; serveUrl: string; bundleDir: string };

/**
 * Bundles a Remotion project into a site of the render service.
 *
 * On Lambda a site is uploaded to S3 and every function downloads it. Here the site is a folder that the next
 * deployService() bakes into the container image: a chunk starts without downloading anything, and the bundle
 * and the renderer in the image are always the same version. The price: a new site needs a new deploy.
 * To change sites without deploying, host the bundle anywhere over https and pass that URL as `serveUrl`.
 */
export async function deploySite(input: DeploySiteInput): Promise<DeploySiteOutput> {
  const siteName = input.siteName ?? 'site';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(siteName)) throw new TypeError(`siteName ${JSON.stringify(siteName)} may only contain letters, digits, ".", "-" and "_"`);
  const entryPoint = resolve(input.entryPoint);
  if (!existsSync(entryPoint)) throw new Error(`No file at ${entryPoint}`);
  let projectDir = dirname(entryPoint);
  while (!existsSync(join(projectDir, 'package.json')) && dirname(projectDir) !== projectDir) projectDir = dirname(projectDir);
  // The bundler of the project itself: the site is built with the Remotion version the composition uses.
  const { bundle } = createRequire(join(projectDir, 'package.json'))('@remotion/bundler') as { bundle: (options: Record<string, unknown>) => Promise<string> };
  const bundleDir = join(resolve(input.sitesDir ?? join(projectDir, 'build', 'sites')), siteName);
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await bundle({
    entryPoint, outDir: bundleDir, rootDir: input.options?.rootDir ?? projectDir, enableCaching: input.options?.enableCaching ?? true,
    ...(input.options?.publicDir !== undefined ? { publicDir: input.options.publicDir } : {}),
    ...(input.options?.webpackOverride ? { webpackOverride: input.options.webpackOverride } : {}),
    onProgress: (progress: number) => input.options?.onBundleProgress?.(progress),
  });
  return { siteName, serveUrl: siteName, bundleDir };
}
