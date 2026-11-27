---
id: deploysite
title: deploySite()
crumb: 'Cloudflare Containers API'
---

# deploySite()

Bundles a Remotion project into a site of your render service. The counterpart of
[`deploySite()`](https://www.remotion.dev/docs/lambda/deploysite) of Lambda and Cloud Run, with one difference that
matters:

**The site is not uploaded. It is written to a folder that the next [`deployService()`](deployservice.md) bakes into
the container image.**

Why: every chunk starts in a fresh browser on some instance. With the bundle in the image a chunk downloads nothing,
and the bundle and the renderer cannot be of different versions. The price is that a changed composition needs a
new deploy (a small image layer).

If you would rather deploy sites without touching the service, host the bundle anywhere over https (for example with
`npx remotion bundle` and any static host, or an existing Lambda site) and pass that URL as `serveUrl` when
rendering. We tested the baked-in route only.

## Example

```ts
import { deploySite } from 'remotion-cloudflare-containers';

const { siteName, serveUrl, bundleDir } = await deploySite({
  entryPoint: 'src/index.ts',
  siteName: 'site',
});
```

## Arguments

### `entryPoint`

The file that calls `registerRoot()`.

### `siteName?`

Letters, digits, `.`, `-`, `_`. Default `'site'`. An existing site of that name is replaced.

### `sitesDir?`

Where sites are collected. Default `<project>/build/sites`. The example Dockerfile copies this folder to
`/app/sites`.

### `options?`

`publicDir`, `rootDir`, `webpackOverride`, `enableCaching`, `onBundleProgress`: passed to
[`bundle()`](https://www.remotion.dev/docs/bundle).

`@remotion/bundler` is loaded from your project, so the site is built with your project's Remotion version.

## Return value

### `siteName`

### `serveUrl`

What to pass as `serveUrl` when rendering. Here it is the site name, not a URL.

### `bundleDir`

Not supported compared with Lambda: `bucketName`, `region`, `privacy`, `gitSource`, upload progress, `stats`.

## See also

- [CLI: sites create](cli.md)
- [Source code](../../packages/cloudflare-containers/src/api/deploy-site.ts)
