---
id: presignurl
title: presignUrl()
crumb: 'Cloudflare Containers API'
---

# presignUrl()

Returns a time-limited URL for a finished render that works without the service secret. The counterpart of
[`presignUrl()`](https://www.remotion.dev/docs/lambda/presignurl).

> Not run by us. It needs R2 S3 API keys that we did not have (the rest of the R2 path is tested). The code follows
> https://developers.cloudflare.com/r2/api/s3/presigned-urls/. Without keys the service answers 501, which we did
> test, and this function resolves to `null`.

## Example

```ts
import { presignUrl } from 'remotion-cloudflare-containers/client';

const url = await presignUrl({ renderId, expiresInSeconds: 3600 });
```

## Arguments

### `renderId`

### `expiresInSeconds`

1 to 604800 (7 days, the R2 maximum).

### `serviceUrl?`, `secret?`

## Return value

A promise resolving to the URL, or to `null` when the service has no R2 bucket or no S3 keys.

Setup: [r2.md](../r2.md).

## See also

- [Source code](../../packages/cloudflare-containers/src/api/presign-url.ts)
