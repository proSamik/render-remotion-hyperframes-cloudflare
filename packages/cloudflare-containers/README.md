# remotion-cloudflare-containers

Render Remotion videos on Cloudflare Containers, with an API shaped like `@remotion/lambda`.

**Unofficial.** Not made or endorsed by Remotion. Not published to npm. Not in the `@remotion/` scope. Using it does
not change Remotion's licence terms: see the repository README.

| Lambda | This package |
| --- | --- |
| `deploySite()` | `deploySite()` (the site is baked into the image) |
| `deployFunction()` | `deployService()` (runs `wrangler deploy`) |
| `renderMediaOnLambda()` | `renderMediaOnCloudflare()` |
| `renderStillOnLambda()` | `renderStillOnCloudflare()` |
| `getRenderProgress()` | `getRenderProgress()` |
| `downloadMedia()` | `downloadMedia()` |
| `presignUrl()` | `presignUrl()` |
| `deleteRender()` | `deleteRender()` |
| `estimatePrice()` | `estimatePrice()` |
| `npx remotion lambda ...` | `remotion-cloudflare ...` |
| `@remotion/lambda-client` | `remotion-cloudflare-containers/client` |

Docs: [docs/cloudflare](../../docs/cloudflare/index.md). Distance from an upstream package:
[UPSTREAMING.md](../../UPSTREAMING.md).

```
src/api/          one file per public function
src/cli/          the command line
src/client.ts     everything that needs no bundler
container/        the engine that runs inside the container: selectComposition, renderMedia, combineChunks
test/             unit tests
```
