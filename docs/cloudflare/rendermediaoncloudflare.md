---
id: rendermediaoncloudflare
title: renderMediaOnCloudflare()
crumb: 'Cloudflare Containers API'
---

# renderMediaOnCloudflare()

Starts a video or audio render on your Cloudflare render service and returns at once. Follow it with
[`getRenderProgress()`](getrenderprogress.md).

The counterpart of [`renderMediaOnLambda()`](https://www.remotion.dev/docs/lambda/rendermediaonlambda). Option names
are the same where the idea is the same.

## Example

```ts
import { renderMediaOnCloudflare } from 'remotion-cloudflare-containers/client';

const { renderId } = await renderMediaOnCloudflare({
  serviceUrl: 'https://rrh-remotion-only.example.workers.dev',
  secret: process.env.REMOTION_CLOUDFLARE_SECRET,
  composition: 'Shapes',
  inputProps: { title: 'Hello', durationInSeconds: 60 },
  codec: 'h264',
  concurrency: 4,
});
```

Until the package is published, import by path:
`../packages/cloudflare-containers/src/client.ts`.

## Arguments

An object with the following properties:

### `composition`

The `id` of the composition to render.

### `serviceUrl?`

The URL of the deployed service. Default: the environment variable `REMOTION_CLOUDFLARE_SERVICE_URL`.

### `secret?`

The value of the service's `RENDER_SECRET`. Default: the environment variable `REMOTION_CLOUDFLARE_SECRET`.
Call this function from a server only.

### `serveUrl?`

Either the name of a site in the service's image (see [`deploySite()`](deploysite.md)) or the `https://` URL of a
deployed Remotion bundle. Default: the only site in the image.

### `inputProps?`

An object that is JSON-serializable. It is sent in the request body. Unlike Lambda, large props are not uploaded to
a bucket first, and `Date`, `Map`, `Set` and `staticFile()` values are not specially encoded.

### `codec?`

`'h264'` (default), `'h265'`, `'vp8'`, `'vp9'`, `'prores'`, `'gif'`, `'mp3'`, `'aac'` or `'wav'`.
Only `'h264'` is rendered in chunks. Any other codec renders in one process on one instance.

### `concurrency?`

How many container instances render this video. Default `1`. The service refuses more than its
`MAX_INSTANCES_PER_RENDER`. On Lambda the option of the same name is the number of functions.

### `processesPerInstance?`

How many chunks one instance renders at the same time, each in its own process with one browser tab. Default `3`,
which measured best on 4 vCPUs. Use `2` for WebGL content. No Lambda counterpart.

### `framesPerChunk?`

Frames per chunk. Default: `frames / (concurrency * processesPerInstance)`, at least 30. The counterpart of
`framesPerLambda`.

### `concurrencyPerProcess?`

Browser tabs per render process. Default `1` when an instance runs several processes. More tabs barely help
without a GPU. The counterpart of `concurrencyPerLambda`.

### `maxRetries?`

How often a failed chunk is rendered again. Default `2`.

### `chunkDeadlineInSeconds?`

How long a chunk may run before it is abandoned, its instance replaced and the chunk rendered again.
Default: `max(300, frames / 1.5)`.

### `duplicateStragglers?`

Start a second copy of a chunk that runs more than twice as long as the median when a slot is free.
Default `true`.

### `frameRange?`

`[first, last]`, inclusive. Default: the whole composition.

### `webgl?`

`true`, or a list of inclusive frame ranges that use WebGL. Chunks that overlap get a WebGL-capable GL backend.
See [GL backends](../gl-backends.md). No Lambda counterpart.

### `chromiumOptions?`

`gl`, `ignoreCertificateErrors`, `disableWebSecurity`, `userAgent`, as in
[`renderMedia()`](https://www.remotion.dev/docs/renderer/render-media#chromiumoptions). An explicit `gl` overrides
`webgl`. Unlike Lambda and Cloud Run, the default `gl` is Remotion's local default, not `swangle`.

### `imageFormat?`, `jpegQuality?`, `scale?`, `crf?`, `videoBitrate?`, `audioBitrate?`, `x264Preset?`, `pixelFormat?`, `proResProfile?`, `colorSpace?`, `muted?`, `everyNthFrame?`, `numberOfGifLoops?`, `envVariables?`, `timeoutInMilliseconds?`, `logLevel?`

Passed to `renderMedia()` unchanged. `colorSpace` defaults to `'bt709'` here.

## Return value

A promise resolving to an object:

### `renderId`

A string to pass to the other functions.

### `serviceUrl`

The service that renders it.

### `progressUrl`

`<serviceUrl>/renders/<renderId>`.

### `outputUrl`

`<serviceUrl>/renders/<renderId>/output`. Needs the `Authorization` header.

## Not supported

Compared with `renderMediaOnLambda()`: `webhook`, `privacy`, `outName`, `downloadBehavior`, `deleteAfter`,
`forceWidth`/`forceHeight`/`forceFps`/`forceDurationInFrames`, `metadata`, `licenseKey`, `overwrite`,
`audioCodec`, `preferLossless`, `offthreadVideoCacheSizeInBytes`, `mediaCacheSizeInBytes`.

## See also

- [getRenderProgress()](getrenderprogress.md)
- [CLI: render](cli.md)
- [Source code](../../packages/cloudflare-containers/src/api/render-media-on-cloudflare.ts)
