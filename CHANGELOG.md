# Changelog

## Unreleased

Diagrams (2026-11-28): architecture, a render phase by phase, Remotion chunking, the HyperFrames split, failure
handling, and where the money goes beside AWS, as Excalidraw files (`docs/diagrams/*.excalidraw`, open them at
excalidraw.com or in the VS Code extension to edit) with SVG exports (white background) in the README and the docs.
Exported locally with Excalidraw's own `exportToSvg` in a headless browser, each checked by a screenshot.

Split HyperFrames on Cloudflare, a shared plan, a determinism pre-flight (2026-11-28):

- **Split HyperFrames ran on Cloudflare**: the 60 s example, 5:37 in one piece against 3:53 in 4 equal chunks on 4
  instances ($0.021 against $0.038 estimated), same frames and sound, SSIM 0.97 to 1.0 per frame
  (docs/hyperframes-split.md, "Measured on Cloudflare").
- **Fixed, found on Cloudflare**: with one process per instance the distributed renderer captured with one browser
  and used about 1 of 4 vCPU; each process now gets `CPUs / processes` capture browsers. A split render below the
  composition's size failed its duration check by 2 frames (B-frames in the re-encode); now encoded without them.
- **Shared plan in R2**: the first instance makes HyperFrames' plan and uploads it with a receipt (key, plan hash,
  SHA-256); the others fetch it instead of planning, and plan themselves if it does not come within 60 s or does not
  match. Every chunk records where its plan came from. Measured: saves the CPU of planning on every other instance;
  no wall time when all instances start together. CI renders it against the storage stand-in.
- **Determinism pre-flight** (`packages/hyperframes-engine/preflight.ts`): flags `Date.now()`, `performance.now()`,
  `new Date()`, `Math.random()` and network scripts, stylesheets and fonts in the project's own code; by default the
  render then runs in one piece with a `plan_warning`; `"preflight": "off"` or `"strict"`.
- **CDN scripts in the project**: `scripts/vendor-scripts.mjs` takes `<script src="https://...">` into
  `assets/vendor/` with a `vendor.lock.json` (SHA-256 checked on every fetch). The three example projects load GSAP
  from the project now; `npm run assets` fetches it.

Deploy to Cloudflare button and an HTTP API (2026-11-28):

- **The repository root is a deployable service**: `wrangler.jsonc`, `deploy/Dockerfile` (Remotion, HyperFrames and
  the mix in one image; the Remotion bundles and the mixed layer are made inside the Docker build, so the builder
  needs nothing but Docker), `deploy/engine.ts` (engine per render: `remotion`, `hyperframes`, `mixed`), an R2 bucket
  binding, `.dev.vars.example` (the one secret, `RENDER_SECRET`), `cloudflare.bindings` descriptions in
  `package.json`, `npm run deploy`. The README has the button; docs/deploy.md is the user's step-by-step.
- **HTTP API** (docs/api.md, docs/openapi.yaml, `clients/render-client.mjs`): a short request form
  (`engine`, `composition`, `inputProps` / `variables`, `range`, `quality`, `tier`) next to the full one;
  `percent` in the progress; `PUT /uploads/<name>` for input files (returns a signed link the containers fetch);
  `GET /renders/<id>/link` (a download link that needs no secret, HMAC-signed with the secret, expiring);
  `POST /renders/<id>/cancel`. The Remotion engine takes `quality` ("480p" ... "4k") like the HyperFrames one.
- Found while validating: `wrangler deploy` creates a missing R2 bucket named in `r2_buckets` by itself
  ("Resources provisioned").
- README: "How this differs from AWS Lambda". docs/costs.md: instance types (named and custom) and how each part is
  billed.

Setup from zero (2026-11-28, validated end to end on Cloudflare under a throw-away name):

- **docs/setup.md**: account and Workers Paid, the permissions (Workers Scripts, Containers, R2), wrangler, the R2
  bucket and the R2 S3 API token (dashboard steps), every secret and variable, building and pushing the image (local
  Docker, Docker on another machine over SSH, or a pushed registry image), deploy pitfalls (exports vs migrations,
  restarts, starts that hang right after a deploy, registry login expiry, stale `containers list`), first render,
  progress and download, logs, limits, billing (CPU, memory, disk, container egress, idle instances), budget alerts,
  updating, teardown. Short version in the README.
- Found while validating: `wrangler delete` leaves the container application running and billing (it says so);
  wrangler builds with `docker build --load`, so a Docker CLI without buildx fails with `unknown flag: --load`;
  wrangler has no command to list or empty an R2 bucket; the usage dataset names applications as dashed UUIDs while
  `wrangler containers list` prints them without dashes; usage appears about 5 minutes late.
- **packages/core/scripts/cf-usage.mjs**: CPU, memory, disk and egress that Cloudflare counted for an application in a
  time window (`containersUsageAdaptiveGroups`), with the list price of each.
- The examples' `wrangler.jsonc`: removing `//` before `r2_buckets` is now the whole edit (the comma was missing).

Container egress and idle warm time (2026-11-28, measured with the private implementation of this design; docs only):

- **Container egress is billed, and the R2 binding does not avoid it.** Cloudflare bills bytes that containers send
  out ($0.025/GB in North America and Europe after 1 TB per month included account-wide; more elsewhere). A render's
  containers send about 2 x the output size (chunks, then the joined file). Uploads routed through an outbound
  handler (`interceptOutboundHttp` + a `WorkerEntrypoint` writing with the R2 binding) were counted in Cloudflare's
  usage analytics (`containersUsageAdaptiveGroups.txBytes`) byte for byte like uploads to the public R2 endpoint.
  Generic lesson: before you route bytes through the Worker to save egress, measure; in our test it saved nothing.
- **Idle warm instances bill memory and disk**: 28 % of one day's billed memory was idle pool time that no render
  recorded. Keep warm pools small and short, and price them into renders.
- README: "What we observed" (per-job Cloudflare vs AWS Lambda + S3, container egress included) and the per-tier
  tables moved to the top; "Why Cloudflare"; a shorter licence note near the top; the "Young code" note says which
  numbers come from which code. docs/costs.md: container egress, idle warm instances, how to read `txBytes`.
  docs/r2.md: the gateway does not save egress.

Split rendering for pure HyperFrames videos (2026-11-28). **Ran on one Mac (up to 8 local instances) and in CI on
Linux. Not run in Docker or on Cloudflare.**

- **`packages/hyperframes-engine/split.ts`**: an MP4 HyperFrames render is cut into frame ranges like a Remotion
  render. Each chunk is rendered by HyperFrames' own distributed renderer (`@hyperframes/producer/distributed`,
  `planV2()` + `renderChunkV2()` with a `frameRange`, pinned to the CLI's version 0.9.103): fresh seek per frame under
  HyperFrames' virtual-time shim, software GL, a closed GOP that starts on an IDR frame, a keyframe at least every 2 s.
  The chunk's MP4 is rewrapped (no re-encode) as MPEG-TS at its place on the timeline; the join streams the chunks into
  one FFmpeg, copies the video and puts HyperFrames' single audio mix of the whole timeline under it. No audio join,
  nothing to drift. Every chunk carries a description (frames, HyperFrames' plan hash, size, SHA-256); the join refuses
  chunks from another plan, gaps, overlaps and damaged files, and checks the frame count and the duration of the result.
  `"split": false` keeps the old path (`hyperframes render` in one piece), which other formats always use.
- **Coordinator**: chunks of different lengths for engines that can join them (`Plan.variableChunks`); an engine
  names its chunk files (`Plan.chunkFiles`, default Remotion's `.ts` + `.aac`); the stitcher gets every chunk's frames.
  Remotion's grid is unchanged (a unit test pins it).
- **`fleet.chunks`** (`--chunks N|auto`), **`fleet.chunkSeconds`** (`--chunk-seconds min,max[,heavyMax]`),
  **`fleet.costWeights`**: `planRanges()` in `packages/core/src/planner.ts` cuts a job into one chunk per process, 2 to
  30 s; with variable chunks, into chunks of equal cost, so a heavy range (`data-render-cost="heavy"`, or a `<canvas>`
  clip, in the composition's HTML) gets shorter chunks and the processes finish together.
- **Output size** for split HyperFrames renders (`"resolution"`): HyperFrames supersamples above the composition's
  size; below it each chunk is scaled and encoded once with the same GOP rule.
- **`examples/hyperframes-only`**: a second, 60 s project (`long/`) with a heavy canvas scene, a frame counter and a
  flash on every second; `npm run local:long`, `npm run compare`, `npm run compare:long`, `npm run cloud:long`.
- **`packages/hyperframes-engine/test/compare-split.ts`**: renders a composition in one chunk and in N, and checks frame
  count, duration, sound, SSIM of every frame (joins reported apart) and, with `--flash`, A/V sync to the frame.
  Unit tests for the range and boundary arithmetic, the planner and the join (on synthetic FFmpeg chunks).
- Found on the way: `-ss 0` on an AAC input with `-c:a copy` makes FFmpeg drop the priming information; the first
  9 ms of sound came out silent. The copy path cuts with `-t` only.
- **docs/hyperframes-split.md** (new), docs/chunking.md, README, AGENTS.md, the example's README.

Output resolution and results from the prototype's final round (2026-11-28):

- **`packages/core/src/resolution.ts`**: a quality name (`360p` to `2160p`, `2k`, `4k`, or the composition's size)
  becomes Remotion's `scale`, the output size and a bitrate. Sizes come out even without cropping (854 x 480 where
  Remotion's own rounding would cut two columns). `RESOLUTION_FACTORS` / `ratesForOutput()` move planner rates to
  another size, from measurements at all six sizes. Unit tests in `packages/core/test/resolution.test.ts`.
- **docs/resolution.md**: rules for a chunked render at another size (one scale per job, pre-rendered layers rendered
  for the output size above the composition's, streaming join for 4K), the measured cost per size (not linear in
  pixels), a 1:44:00 project at 480p, 720p and 1080p and 11 minutes at 4K, and "preview first, then the final".
  README: a table of those runs.
- **docs/failures.md**: seven failure drills to run against a deployment, with what must happen, and the four bugs
  they found in the prototype. **docs/chunking.md**: why the joined audio is 43-96 ms longer than the video and why
  to leave it. **docs/planning.md**: output size changes the rates; how close a sample-based estimate got.

Earlier in this release: lessons from a private prototype of the same design, which ran one-hour jobs on 100 to 292 Cloudflare `standard-4`
instances on 2026-11-27 and 28. Written again for this repository. **Everything below ran locally on macOS: 39 unit
tests, the three examples, whole renders against an S3 stand-in in memory. CI runs the same on Linux. None of it has
been deployed to Cloudflare from this code base yet.** The Cloudflare results in the README are those of 0.1.0.

Coordinator (`packages/core/src/coordinator.ts`):

- **Every run writes its own files.** A retry or a second run of a chunk gets its own file names and object keys
  (`chunk-0003-r2.ts`, `output-r1`, `output-s0-0`), and the join is told which runs won. Before, two runs of a chunk
  wrote the same key: a second run that finished late could overwrite the winner. That happened in the prototype.
- **Hedging only for measurably slow runs, with a cap.** A second run needs a frame rate under half the median (or no
  first frame after three times the usual time), a free slot on another instance, an empty queue; once per chunk, for
  at most `maxHedgeShare` (5 %) of the chunks. The old rule duplicated anything that ran twice the median. In the
  prototype a rule of that kind started 57 and 159 second runs in two jobs, of which 1 and 0 won. The progress now has
  `hedges: { started, won }`.
- **A lost instance is not a failed chunk.** Runs lost to a restart are counted apart (`lost`) and do not use up
  `maxRetries`.
- **No-progress limit.** A chunk without a new frame for `max(150 s, deadline / 2)` is replaced without waiting for
  its deadline.
- **5xx is "not ready yet".** A `500` to the plan request is tried again (up to 5 times) instead of ending the
  render. A `503` "no Container instance available" was already treated as waiting; there is now a test for it.
- **CPU from the instance counter.** `costs.cpuSeconds` adds up the increases of each instance's own counter, so a
  task server that restarts does not lose what it had used. Tasks that share an instance were never added up for the
  bill; that is now documented and tested.
- **Progress never goes backwards.** `overallProgress` keeps its highest value when chunks are rendered again, and is
  1 only when the render is done.
- **Errors are structured.** Every `errors` entry has a `kind` and, where it applies, an `attempt`.
  `packages/core/src/events.ts` maps them to a level and a fingerprint for an error tracker; the Worker logs one JSON
  line per event.
- Join attempts and lost stitchers have their own counters (the old count was read from the capped `errors` list),
  and a stitcher that keeps dying ends the render instead of starting instances for ever.

Transfers (`packages/core/src/transfer.ts`, task server, Worker):

- **Checksums end to end.** Chunks fetched for a join are compared with their recorded size and SHA-256 before they
  are joined (they were not checked at all on the R2 path). Uploads through the gateway carry the SHA-256 and R2
  checks it. Uploads over a presigned URL are checked against the ETag. A file sent to an instance gets its name only
  when it is complete.
- Error messages never contain the query string of a URL.
- The Worker deletes a render's objects page by page (a listing returns 1000 at most).

Long videos ([docs/long-videos.md](docs/long-videos.md)):

- **Streaming join.** `stitch: 'stream'` feeds the MPEG-TS chunks through a pipe in order, joins the audio with
  Remotion's seamless AAC method in batches, verifies each chunk before it is fed and deletes it after. The MP4 is
  byte for byte what `combineChunks()` writes (a CI step checks that on real chunks). `'stream-fmp4'` writes a fragmented MP4
  that is uploaded in parts while it is produced, so the output never needs the disk.
- `packages/core/src/chunk-feed.ts`: parallel fetch inside a window of bytes.

Storage ([docs/r2.md](docs/r2.md), [docs/inputs.md](docs/inputs.md)):

- `s3-presign.ts`: presigned URLs with WebCrypto, checked against `aws4fetch` in a test. The Worker uses it for the
  download URL, and with `R2_DIRECT="true"` for chunks and outputs: containers and R2 talk directly, the containers
  hold no keys.
- `signer.ts`: a narrow signing policy (one bucket, per-user and per-job prefixes, the multipart calls, 6 hours).
- `multipart.ts`: client-side multipart upload, resumable without local state (ListMultipartUploads, ListParts, part
  MD5 against ETag, composite ETag).
- `range-proxy.ts`: a loopback proxy that fetches only the byte ranges of a remote file that a page reads.

Other:

- `planner.ts` and [docs/planning.md](docs/planning.md): tiers as finish-time targets, cost classes, and the
  prototype's rules for warm instances, fair sharing and leases (patterns, not built).
- `packages/core/scripts/webgl-selftest.mjs` and `RENDER_SELFTEST`: prove at image build and at instance start that
  the pinned browser can do WebGL ([docs/gl-backends.md](docs/gl-backends.md)).
- CLI: `--stitch`, `--no-hedge`, `--max-hedge-share`, `--keep-work`.
- CI: the streaming join against `combineChunks()` on the same chunks; a render through object storage (stand-in).

Changed behaviour to know about:

- Chunk file names and R2 keys have a run suffix. A render that is in flight while this version is deployed may
  fail; start it again.
- `GET /renders/<id>` has a new field `hedges`; `errors[].kind` is new; `overallProgress` is at most 0.999 until
  `done`.
- An engine's `stitch()` should read the file names from `task.chunks` (the Remotion engine does). `task.outputBase`
  names a chunk's files.
- The Worker no longer imports `aws4fetch`; it is a test dependency only.

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
