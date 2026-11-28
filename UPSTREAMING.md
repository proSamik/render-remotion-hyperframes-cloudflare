# Upstreaming: what it would take to propose this to Remotion

`packages/cloudflare-containers` is shaped after Remotion's own cloud packages so that it could one day be offered
as a pull request to https://github.com/remotion-dev/remotion. It is not that today. Nothing has been proposed,
opened or discussed upstream. This file is the honest gap list.

Read from `remotion-dev/remotion@main` (v4.0.547) on 2026-11-27.

## What exists upstream already

- **A Cloudflare Containers page and demo.** `packages/docs/docs/cloudflare-containers.mdx` and
  https://github.com/remotion-dev/cloudflare-containers-demo. One container, a synchronous `POST /render`, the MP4
  buffered in the Worker and written to R2. The docs call it "a proof of concept ... not production-ready" and list
  what it lacks: authentication, queueing, progress, error propagation.
- **`@remotion/lambda` and `@remotion/lambda-client`**: the reference design. Distributed rendering, progress in
  S3, webhooks, cost estimation, a CLI inside `npx remotion`.
- **`@remotion/cloudrun`**: one `renderMedia()` per request, no chunking. "currently not being actively developed".
  The docs say the plan is to port the Lambda runtime to Cloud Run as a new package.
- **`@remotion/vercel`** (experimental, since 4.0.426): `createSandbox()`, `addBundleToSandbox()`,
  `renderMediaOnVercel()`, `getRenderProgress()`, `uploadToVercelBlob()`. One machine, no chunking, no CLI, no tests.
- **`combineChunks()` and the distributed-rendering page**: the public contract this package uses.

The Cloud Run plan tells you what the maintainers would want from a third provider: the Lambda runtime ported, not
a parallel implementation. This package is a parallel implementation.

## How close the API is

| Lambda | Here | Same? |
| --- | --- | --- |
| `deploySite({ entryPoint, bucketName, region, siteName })` -> `{ serveUrl, siteName, stats }` | `deploySite({ entryPoint, siteName, sitesDir })` -> `{ serveUrl, siteName, bundleDir }` | Name and idea. The site is baked into the image instead of uploaded; `serveUrl` is a site name. Upstream now prefers `bundle()` + `deploySiteFromBundle()`. |
| `deployFunction({ region, memorySizeInMb, timeoutInSeconds, ... })` -> `{ functionName, alreadyExisted }` | `deployService({ cwd })` -> `{ serviceUrl, output }` | Name borrowed from Cloud Run. Configuration lives in `wrangler.jsonc`, not in arguments. No `alreadyExisted`. |
| `getOrCreateBucket()` | none | R2 bucket is created by the user and bound in `wrangler.jsonc`. |
| `renderMediaOnLambda({ region, functionName, serveUrl, composition, codec, inputProps, framesPerLambda, concurrency, concurrencyPerLambda, maxRetries, ... })` -> `{ renderId, bucketName, ... }` | `renderMediaOnCloudflare({ serviceUrl, secret, serveUrl, composition, codec, inputProps, framesPerChunk, concurrency, processesPerInstance, concurrencyPerProcess, maxRetries, ... })` -> `{ renderId, serviceUrl, progressUrl, outputUrl }` | Same shape and the same render option names. `framesPerLambda` -> `framesPerChunk`, `concurrencyPerLambda` -> `concurrencyPerProcess`; `processesPerInstance` is new. |
| `renderStillOnLambda()` -> `{ url, sizeInBytes, estimatedPrice, renderId }` | `renderStillOnCloudflare()` -> `{ outputUrl, sizeInBytes, estimatedPrice, renderId, outputPath }` | Close. |
| `getRenderProgress({ renderId, bucketName, functionName, region })` | `getRenderProgress({ renderId })` | Same name. Returns the common core: `overallProgress`, `done`, `framesRendered`, `fatalErrorEncountered`, `errors`, `outputFile`, `outputSizeInBytes`, `timeToFinish`, `costs`, `renderId`. `chunks` is an object here, a number there. About 20 Lambda fields are missing. |
| `presignUrl({ region, bucketName, objectKey, expiresInSeconds })` | `presignUrl({ renderId, expiresInSeconds })` | Same name. Addressed by render, not by key. Not run by us. |
| `downloadMedia()` | `downloadMedia()` | Same. |
| `deleteRender()`, `cancelRenderOnLambda()` | `deleteRender()` | One function does both. |
| `estimatePrice({ region, memorySizeInMb, diskSizeInMb, lambdasInvoked, durationInMilliseconds })` | `estimatePrice({ cpuSeconds, instanceSeconds, instanceType })` | Same name, different inputs, because the billing model differs. |
| `getFunctions()`, `getSites()`, `getRegions()`, `deleteSite()`, `deleteFunction()` | `getServiceInfo()` only | Missing. |
| `validateWebhookSignature()`, webhooks | none | Missing. |
| `getCompositionsOnLambda()` | none | Missing. |
| `npx remotion lambda sites create / functions deploy / render / still / policies / quotas` | `remotion-cloudflare sites create / services deploy / services info / render / still / progress / rm / doctor` | Same verbs. Its own binary: `@remotion/cli` hardcodes `lambda` and `cloudrun`. |
| `@remotion/lambda-client` (no bundler) | `remotion-cloudflare-containers/client` | Same split, as an export path. |

Compared with `@remotion/vercel`: that API is sandbox-centred (`createSandbox`, `addBundleToSandbox`, then
`renderMediaOnVercel({ sandbox, compositionId })`). Ours follows Lambda (`serveUrl`, `composition`, `renderId`)
because the unit here is a service, not a sandbox the caller holds. Two things we do like Vercel: the bundle is
copied to where the render runs instead of being fetched over the network, and a detached render is followed by
polling a progress document.

## What would have to change for a pull request

1. **Name and scope.** `@remotion/cloudflare` or similar, version from `packages/core/src/version.ts`,
   `"license": "SEE LICENSE IN LICENSE.md"`. Today: `remotion-cloudflare-containers`, private, MIT.
2. **Monorepo build.** Bun workspaces and Turborepo, `workspace:*` and `catalog:` dependencies, a `bundle.ts`,
   compiled `dist/`, `eslint.config.mjs` with `@remotion/eslint-config-internal`, Oxfmt formatting. Today: TypeScript
   run directly by Node, npm, no lint, no formatter.
3. **The new-package checklist** (`.agents/skills/add-new-package/SKILL.md` upstream): register in the root
   `tsconfig.json`, `packages/cli/src/list-of-remotion-packages.ts`,
   `packages/create-video/src/list-of-remotion-packages.ts`, `packages/studio-shared/src/package-info.ts`; docs
   `index.mdx`, `table-of-contents.tsx`, `sidebars.ts`, `components/TableOfContents/api.tsx`, rendered cards.
4. **CLI integration.** `npx remotion cloudflare ...` needs a patch to `@remotion/cli`, as `lambda` and `cloudrun`
   have.
5. **Docs as MDX.** The pages in `docs/cloudflare/` have Remotion's structure (front matter, Example, Arguments with
   one heading per option, Return value, See also) but are Markdown. They need `ts twoslash` examples that compile,
   `<AvailableFrom>` tags, an `<ExperimentalBadge>`, and the existing `cloudflare-containers.mdx` rewritten or linked.
6. **Internal APIs.** Upstream packages call `internalRenderMedia` and friends, use
   `NoReactInternals.serializeJSONWithSpecialTypes` for input props, wrap public functions in
   `wrapWithErrorHandling`, and pass `licenseKey` and telemetry through. We call the public `renderMedia()` and send
   plain JSON.
7. **Tests.** Upstream uses `bun test`, with unit and integration folders per package. We have 39 unit tests with
   `node:test` (coordinator against a simulated fleet, transfers and uploads against a store in memory, the streaming
   join, option mapping, pricing), end-to-end renders in CI, and manual runs on Cloudflare. No test
   deploys to Cloudflare, and upstream would need a way to run that in CI or accept that it cannot.
8. **Licence.** There is no CLA. The contributing page says: "By sending pull requests, you agree that we can use
   your code changes in a commercial context." Code offered upstream would leave MIT and fall under Remotion's
   licence. That is the owner's decision to make, not this file's.
9. **Talk first.** The contributing page: "Planning something bigger? Open an issue or reach out ... first", and
   "We can't review or merge every pull request." A new cloud provider is a large maintenance commitment for them.

## What the maintainers would likely ask

- Why not port the Lambda runtime (handlers `start`, `launch`, `renderer`, `still`, `progress`) as planned for
  Cloud Run, so that retries, progress fields, webhooks and the chunk logic are shared?
- Who maintains it when Cloudflare changes the Containers API? It changed during the weeks around this work: the
  `Container` class we first measured with is now called deprecated in the docs, and the API used here is in beta.
- How is it tested without a Cloudflare account in CI?
- Does a chunked self-hosted render report one render or many to the licence telemetry?
- Why is the site baked into the image rather than served from R2, like S3 on Lambda?
- What happens above 100 MiB per chunk, above 20 GB per render, and with 100 instances?
- The streaming join repeats arithmetic of `combineChunks()` (the AAC in and out points) outside Remotion. It has to
  be checked again with every Remotion version; upstream it would simply be an option of `combineChunks()`.

## Not at parity with Lambda or Cloud Run

- Only H.264 is chunked. Every other codec renders on one instance.
- No webhooks, no `privacy`, no `outName`, no `downloadBehavior`, no `deleteAfter`, no `forceWidth` and similar
  overrides, no `metadata`, no `licenseKey`, no custom `audioCodec`.
- Input props: plain JSON, no special types, no bucket fallback for large payloads.
- `getRenderProgress()` returns a subset; error entries have a `kind` and an `attempt` but no `stack` or `willRetry`.
- No `getServices()`, `getSites()`, `deleteSite()`, `deleteService()`, `getCompositions...()`, `getRegions()`.
- No version check between client and service (the site and renderer cannot mismatch, but the client and the Worker
  can).
- Each chunk calls `selectComposition()` itself. Remotion's distributed-rendering page says to pass the composition
  from the main routine to the workers.
- No queue and no rate limit.
- No clients in other languages.
- Run a few dozen times, by one person, on one account, with at most 4 instances in this code base.
- The WebGL path that was cheapest in our measurement needs a browser build that Remotion does not ship.

## What is arguably ahead of the existing Cloudflare demo and Cloud Run

- Distributed rendering with seamless audio joins, verified.
- Authentication, progress by frames, propagated errors.
- Per-chunk deadlines, retries on a fresh instance, a second run for measurably slow chunks, one set of files per
  run, checksums on every transfer.
- A join that does not need chunks and output on one disk, with the same result as `combineChunks()`.
- Cost reported per render from measured CPU time.
- Runs locally and in Docker with the same coordinator.
- Written for Cloudflare's current Containers API.
