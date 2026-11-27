---
id: getrenderprogress
title: getRenderProgress()
crumb: 'Cloudflare Containers API'
---

# getRenderProgress()

Gets the state of a render started with [`renderMediaOnCloudflare()`](rendermediaoncloudflare.md). The counterpart
of [`getRenderProgress()`](https://www.remotion.dev/docs/lambda/getrenderprogress) of Lambda.

## Example

```ts
import { getRenderProgress } from 'remotion-cloudflare-containers/client';

const progress = await getRenderProgress({ renderId });
if (progress.fatalErrorEncountered) throw new Error(progress.errors.map((error) => error.message).join('\n'));
if (progress.done) console.log('finished in', progress.timeToFinish, 'ms');
else console.log(Math.round(progress.overallProgress * 100), '%');
```

Poll every 2 seconds. The call reads stored state and does not touch the render.

## Arguments

### `renderId`

### `serviceUrl?`, `secret?`

As in `renderMediaOnCloudflare()`.

## Return value

### `overallProgress`

A number from 0 to 1. 90 % of it is frames rendered, 5 % chunks brought together, 5 % the join.

### `done`

`true` when the output exists.

### `phase`

`'planning'`, `'rendering'`, `'stitching'`, `'done'` or `'failed'`. No Lambda counterpart.

### `framesRendered`, `frames`

### `chunks`

`{ total, rendered, stored, running }`. On Lambda `chunks` is a number.

### `instances`

Container instances alive for this render. The counterpart of `lambdasInvoked`.

### `fatalErrorEncountered`

`true` when the render stopped.

### `errors`

An array of `{ at, message, fatal, chunk?, instance? }`. Problems that were recovered from are listed with
`fatal: false`. Lambda's entries carry more fields (`type`, `stack`, `attempt`, `willRetry`, ...).

### `outputFile`

The file name of the output once it exists, otherwise `null`. Not a URL: download with
[`downloadMedia()`](downloadmedia.md) or get a URL with [`presignUrl()`](presignurl.md).

### `outputSizeInBytes`, `outputSha256`

### `timeToFinish`

Milliseconds from start to finish, or `null`.

### `costs`

`{ accruedSoFar, currency, cpuSeconds, instanceSeconds, disclaimer }`. An estimate at list price. See
[Cost](cost.md).

## Not in the return value

Compared with Lambda: `encodingStatus`, `renderMetadata`, `bucket`, `outKey`, `mostExpensiveFrameRanges`,
`retriesInfo`, `timeToEncode`, `timeToRenderFrames`, `artifacts`, `estimatedBillingDurationInMilliseconds`.

## See also

- [Progress reporting](../progress.md)
- [Source code](../../packages/cloudflare-containers/src/api/get-render-progress.ts)
