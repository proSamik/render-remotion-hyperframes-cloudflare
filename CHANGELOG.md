# Changelog

## Unreleased

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
