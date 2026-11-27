---
id: getserviceinfo
title: getServiceInfo()
crumb: 'Cloudflare Containers API'
---

# getServiceInfo()

Asks a deployed service what it is. The nearest counterpart of
[`getServiceInfo()`](https://www.remotion.dev/docs/cloudrun/getserviceinfo) and `getFunctionInfo()`.

## Example

```ts
import { getServiceInfo } from 'remotion-cloudflare-containers/client';

const info = await getServiceInfo();
// { serviceUrl, ok: true, service: 'rrh-remotion-only', storage: false, instanceType: 'standard-4', maxInstancesPerRender: 4 }
```

## Arguments

### `serviceUrl?`, `secret?`

## Return value

### `service`

The `SERVICE_NAME` variable.

### `storage`

`true` when an R2 bucket is bound.

### `instanceType`

### `maxInstancesPerRender`

There is no `getServices()` that lists services: use `npx wrangler deployments list` and
`npx wrangler containers list`.
