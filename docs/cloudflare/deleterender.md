---
id: deleterender
title: deleteRender()
crumb: 'Cloudflare Containers API'
---

# deleteRender()

Stops every instance of a render, deletes its files (on the instances and in R2) and its state. A render that is
still running is cancelled. The counterpart of
[`deleteRender()`](https://www.remotion.dev/docs/lambda/deleterender); it also does what `cancelRenderOnLambda()`
does.

## Example

```ts
import { deleteRender } from 'remotion-cloudflare-containers/client';

await deleteRender({ renderId });
```

Call it after every download. Without R2, one instance stays up holding the output until you do (or until its
inactivity timeout).

## Arguments

### `renderId`

### `serviceUrl?`, `secret?`

## Return value

`{ deleted: renderId }`.

## See also

- [Source code](../../packages/cloudflare-containers/src/api/delete-render.ts)
