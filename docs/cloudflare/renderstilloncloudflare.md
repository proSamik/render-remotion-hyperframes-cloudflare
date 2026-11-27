---
id: renderstilloncloudflare
title: renderStillOnCloudflare()
crumb: 'Cloudflare Containers API'
---

# renderStillOnCloudflare()

Renders one frame on your Cloudflare render service and waits until it is done. The counterpart of
[`renderStillOnLambda()`](https://www.remotion.dev/docs/lambda/renderstillonlambda).

## Example

```ts
import { renderStillOnCloudflare } from 'remotion-cloudflare-containers/client';

const { outputPath, sizeInBytes, estimatedPrice } = await renderStillOnCloudflare({
  composition: 'WebFont',
  frame: 100,
  imageFormat: 'png',
  outPath: 'out/still.png',
});
```

## Arguments

### `composition`, `serviceUrl?`, `secret?`, `serveUrl?`, `inputProps?`, `scale?`, `jpegQuality?`, `webgl?`, `chromiumOptions?`, `envVariables?`, `timeoutInMilliseconds?`

As in [`renderMediaOnCloudflare()`](rendermediaoncloudflare.md).

### `frame?`

Which frame. Default `0`.

### `imageFormat?`

`'png'` (default), `'jpeg'`, `'webp'` or `'pdf'`.

### `outPath?`

If given, the image is downloaded to this path and checked against its SHA-256.

## Return value

### `renderId`

### `outputUrl`

### `sizeInBytes`

### `estimatedPrice`

`{ accruedSoFar, currency: 'USD' }`, from CPU time measured in the instance. See [Cost](cost.md).

### `outputPath`

The absolute path of the downloaded file, or `null` without `outPath`.

A still took 6 seconds on a warm instance in our test. The render is not deleted for you: call
[`deleteRender()`](deleterender.md).

## See also

- [Source code](../../packages/cloudflare-containers/src/api/render-still-on-cloudflare.ts)
