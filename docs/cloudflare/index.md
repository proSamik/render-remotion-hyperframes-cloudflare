---
id: cloudflare
title: Cloudflare Containers
crumb: 'Unofficial'
---

# Remotion on Cloudflare Containers

> Unofficial. This package is not made or endorsed by Remotion, is not on npm and does not use the `@remotion/`
> scope. The pages in this folder are written in the layout of Remotion's own Lambda and Cloud Run docs so that
> they could be proposed upstream later. See [UPSTREAMING.md](../../UPSTREAMING.md).

`remotion-cloudflare-containers` (`packages/cloudflare-containers`) renders Remotion videos on
[Cloudflare Containers](https://developers.cloudflare.com/containers/): a Worker takes the request, a Durable Object
coordinates the render, and container instances run `@remotion/renderer`. A video is split into chunks that render
in parallel on several instances and are joined with `combineChunks()`.

Remotion's own docs describe a Cloudflare Containers proof of concept
(https://www.remotion.dev/docs/cloudflare-containers) that renders on one container and names what it lacks:
authentication, progress, error propagation. This package adds those, and distributed rendering.

## When to use it

- You already use Cloudflare and want renders next to your Workers and R2.
- You want distributed rendering without AWS.
- You want to choose the image yourself: fonts, the GL backend, extra tools next to the renderer.

Use Remotion Lambda instead if you want the path that Remotion maintains and recommends, the fastest renders
(up to 200 functions per render), or webhooks. See [the comparison](comparison.md).

## Pages

- [Setup](setup.md)
- [How it works](how-it-works.md)
- API: [deploySite()](deploysite.md), [deployService()](deployservice.md),
  [renderMediaOnCloudflare()](rendermediaoncloudflare.md), [renderStillOnCloudflare()](renderstilloncloudflare.md),
  [getRenderProgress()](getrenderprogress.md), [downloadMedia()](downloadmedia.md), [presignUrl()](presignurl.md),
  [deleteRender()](deleterender.md), [estimatePrice()](estimateprice.md), [getServiceInfo()](getserviceinfo.md)
- [CLI](cli.md)
- [Limits](limits.md)
- [Cost](cost.md)
- [Comparison with Lambda, Cloud Run and Vercel Sandbox](comparison.md)
- [Troubleshooting](troubleshooting.md)

## Versions

Tested with Remotion 4.0.530, wrangler 4.169.0, Node 22 and 26, in November 2026. The `remotion` and `@remotion/*`
packages of your project must all have the same version; the renderer in the image is installed from your project's
lock file, so the site and the renderer always match.
