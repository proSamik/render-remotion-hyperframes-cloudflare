# Changelog

## 0.1.0 (2026-11-28)

First version.

- `packages/core`: render coordinator (chunk plan, per-chunk deadline, retries on a fresh instance, duplicate
  stragglers, SHA-256 on every transfer, progress by frames), container task server, Worker with two Durable Objects
  on Cloudflare's Durable Object Container API, optional R2 through an outbound intercept, HTTP client, local and
  Docker runners, 10 unit tests against a simulated fleet.
- `packages/cloudflare-containers`: Remotion engine (`selectComposition`, `renderMedia`, `combineChunks`), an API
  shaped like `@remotion/lambda` (`deploySite`, `deployService`, `renderMediaOnCloudflare`,
  `renderStillOnCloudflare`, `getRenderProgress`, `downloadMedia`, `presignUrl`, `deleteRender`, `estimatePrice`,
  `getServiceInfo`), the `remotion-cloudflare` CLI.
- `packages/hyperframes-engine`: runs `hyperframes render`.
- Examples: `remotion-only`, `hyperframes-only`, `mixed`.
- Tested with Remotion 4.0.530, HyperFrames 0.9.103, wrangler 4.169.0 on Cloudflare `standard-4`.

Known gaps are listed in the README under "Limits and known problems".
