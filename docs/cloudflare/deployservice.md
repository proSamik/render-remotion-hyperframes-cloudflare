---
id: deployservice
title: deployService()
crumb: 'Cloudflare Containers API'
---

# deployService()

Deploys the render service: the Worker, the Durable Objects and the container image. It runs `wrangler deploy` in a
folder that holds a `wrangler.jsonc` and a `Dockerfile`. The counterpart of
[`deployFunction()`](https://www.remotion.dev/docs/lambda/deployfunction) and
[`deployService()`](https://www.remotion.dev/docs/cloudrun/deployservice).

Wrangler must be logged in and Docker must be running.

## Example

```ts
import { deployService, deploySite } from 'remotion-cloudflare-containers';

await deploySite({ entryPoint: 'src/index.ts' });
const { serviceUrl } = await deployService({ cwd: '.', onLog: console.log });
```

## Arguments

### `cwd`

The service folder. Start from `examples/remotion-only`.

### `wranglerArgs?`

Extra arguments for `wrangler deploy`, for example `['--dry-run']`.

### `onLog?`

Called with every line wrangler prints.

## Return value

### `serviceUrl`

The `workers.dev` URL from wrangler's output, or `null` if none was printed (custom routes only).

### `output`

Everything wrangler printed.

## Differences from Lambda and Cloud Run

- The service is described by files you own (`wrangler.jsonc`, `Dockerfile`), not by arguments. Memory, CPU and
  disk come from the instance type in `wrangler.jsonc` (`INSTANCE_TYPE`, default `standard-4`).
- There is no ready-made image published by anyone. Your image is built from your project.
- The service name does not encode the Remotion version, and there is no `speculateServiceName()` or
  `compatibleOnly`. The version cannot mismatch because the site and the renderer are built into one image.
- The secret is not set by this function: `npx wrangler secret put RENDER_SECRET`.

## See also

- [Setup](setup.md)
- [Source code](../../packages/cloudflare-containers/src/api/deploy-service.ts)
