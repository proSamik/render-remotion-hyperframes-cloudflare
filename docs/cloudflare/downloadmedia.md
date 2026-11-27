---
id: downloadmedia
title: downloadMedia()
crumb: 'Cloudflare Containers API'
---

# downloadMedia()

Downloads a finished render to a file and checks it against the SHA-256 computed where the file was made. The
counterpart of [`downloadMedia()`](https://www.remotion.dev/docs/lambda/downloadmedia).

## Example

```ts
import { downloadMedia } from 'remotion-cloudflare-containers/client';

const { outputPath, sizeInBytes } = await downloadMedia({ renderId, outPath: 'out/video.mp4' });
```

## Arguments

### `renderId`

### `outPath`

### `serviceUrl?`, `secret?`

## Return value

### `outputPath`

Absolute path.

### `sizeInBytes`

It throws if the render is not finished, and after three attempts if the file keeps arriving damaged.

Without R2 the file is streamed from the instance that joined it, so download soon after the render and then call
[`deleteRender()`](deleterender.md).

## See also

- [Source code](../../packages/cloudflare-containers/src/api/download-media.ts)
