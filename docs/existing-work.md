# Existing work, and what we changed because of it

Before writing this guide we searched GitHub and the docs of Remotion, HeyGen and Cloudflare (2026-11-27) and read
the README and the key files of what we found. Stars and dates are as of that day.

## Remotion on Cloudflare

| Project | What it does | How current | Different from this guide |
| --- | --- | --- | --- |
| [remotion-dev/cloudflare-containers-demo](https://github.com/remotion-dev/cloudflare-containers-demo), documented at https://www.remotion.dev/docs/cloudflare-containers | Official proof of concept. One container named `renderer`, a synchronous `POST /render`, the whole MP4 buffered in the Worker (`arrayBuffer()`) and written to R2. | 25 stars, last push July 2025, Remotion 4.0.321, `@cloudflare/containers` 0.0.19 | No chunking, no auth, no progress, no error propagation, by its own description "not production-ready". Uses the `Container` class. |
| [odysseaspapadimas/cloudflare-remotion-example](https://github.com/odysseaspapadimas/cloudflare-remotion-example) | The closest to this guide. Chunked `h264-ts` + `.aac`, `combineChunks` in a "leader" container, one coordinator Durable Object per job, R2 for chunks through outbound handlers, progress pushed from the containers. | 1 star, April 2026, Remotion 4.0.441, `@cloudflare/containers` 0.2.0, `standard-4` | One process with `concurrency: 3` per container instead of 3 processes; 60 s alarm with a 300 s stuck-chunk timeout; R2 required; `Container` class. No HyperFrames. |
| [yerffejytnac/remotion-cloudflare-containers](https://github.com/yerffejytnac/remotion-cloudflare-containers) | A variation of the official demo for map rendering, `gl: "angle"`, S3 credentials in the request body. | 1 star, December 2025 | Single container; credentials travel with each request. |

Remotion's docs also say plainly that plain Workers cannot render (`miscellaneous/render-on-edge`) and recommend
Lambda over building your own distributed renderer (`distributed-rendering`).

## Remotion on other platforms

| Project | Notes |
| --- | --- |
| `@remotion/lambda` | The reference. Distributed, progress in S3, webhooks. Forces `swangle`. |
| `@remotion/cloudrun` | `node:22-bookworm-slim`, the standard Chrome library list, browser through `ensureBrowser()`, no FFmpeg package, one `renderMedia()` per request, no chunking. Not actively developed. |
| `@remotion/vercel` and `template-vercel` | Experimental. Installs the renderer into a Vercel Sandbox, copies the bundle in, runs a render script, reads progress lines, uploads to Vercel Blob. One machine. |
| Remotion's Docker guide (https://www.remotion.dev/docs/docker) | The base image and library list our Remotion Dockerfile follows. |

We found no maintained Remotion example for Fly.io, Modal or ECS in a repository search, and did not look further.

## HyperFrames in the cloud

| Project | What it does | Different from this guide |
| --- | --- | --- |
| [heygen-com/hyperframes-cloudflare-template](https://github.com/heygen-com/hyperframes-cloudflare-template) | Official. Composition files sent as base64 JSON in a synchronous `POST /render`; the container runs `hyperframes render --workers auto`; the Worker streams the MP4 into R2. `standard-4`. 30 stars, November 2026. | The composition arrives in the request (any caller can render any HTML); one long request; no secret. Here the composition is in the image and the render is a job you poll. |
| `hyperframes lambda`, `hyperframes cloudrun` (in [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)) | Official distributed rendering on AWS and GCP, built on `@hyperframes/producer/distributed` (`plan`, `renderChunk`, `assemble`). | Not Cloudflare. The split HyperFrames path here is built on `planV2()` and `renderChunkV2()` from it, with this repository's coordinator and its own join ([hyperframes-split.md](hyperframes-split.md)). |
| `hyperframes cloud render` | HeyGen's hosted renderer. | Not your own account. |
| A few small third-party clones of the HeyGen template | | One runs as a non-root user with `enableInternet = false` and destroys the container before and after every job. |

We found nothing that renders Remotion and HyperFrames together on Cloudflare.

## Where our first design was wrong or more complicated than needed

Our starting point was a private prototype. Reading the above changed these things:

| We did | Others do | What we changed |
| --- | --- | --- |
| Installed Debian's `ffmpeg` in the Remotion image | Nobody does. Remotion ships its own FFmpeg since v4. | Removed from the Remotion image. Only the HyperFrames and mixed images have it, because HyperFrames needs `ffmpeg` on the PATH. |
| Installed a pinned Chrome build ourselves with `@puppeteer/browsers` | `ensureBrowser()` / `npx remotion browser ensure` for Remotion, `hyperframes browser ensure` for HyperFrames: each framework's own pinned build | Each framework installs its own browser. (A second browser is optional for WebGL: [gl-backends.md](gl-backends.md).) |
| Ran as a non-root user "for the sandbox" | Everyone runs as root. Remotion always passes `--no-sandbox`; and Cloudflare's docs say that under the `durable_object` policy every process has root's capabilities anyway. | Run as root. The isolation is the instance, and the docs say so ([security.md](security.md)). |
| Set `enableMultiProcessOnLinux: true` and worried about `/dev/shm` | It is the default since Remotion 4.0.137, and both frameworks pass `--disable-dev-shm-usage` themselves. | Nothing to configure. |
| Passed chunks container to Worker to container, with checksums, and treated R2 as "later" | odysseas lets the container talk to R2 through a Worker outbound handler: no credentials in the container, nothing through the coordinator. Cloudflare documents the pattern. | Implemented the same with the new API (`interceptOutboundHttp` + a `WorkerEntrypoint`) and tested it. The checksummed route stays as the no-R2 fallback. |
| Used the `Container` class of `@cloudflare/containers` | So does every existing example. | Cloudflare's docs call the class deprecated since November 2026. This guide uses `ctx.container` with the `durable_object` scheduling policy instead. None of the projects above did when we read them. |
| Pinned HyperFrames' producer and called it from our own code | The official template just runs the `hyperframes render` CLI. | We ran the CLI. Split rendering now calls the producer's public distributed API (`@hyperframes/producer/distributed`), pinned to the CLI's version. |
| Assumed a Docker image that works in Docker works on Cloudflare | | It did not for HyperFrames: on Cloudflare it refused its browser cache. `HYPERFRAMES_BROWSER_PATH` fixes it. Found by testing, not by reading. |

## Where we kept our own way, and why

- **3 render processes with 1 tab each**, not 1 process with 3 tabs. We measured both on `standard-4`: tabs gave
  9.9 to 10.6 fps, processes 9.9 to 16.6 fps ([concurrency.md](concurrency.md)).
- **Polling from the coordinator**, not progress pushed by the containers. A poll is needed anyway to notice a dead
  container, and one mechanism is easier to reason about. The cost is one request per instance every 1.5 seconds.
- **A 1.5 s coordinator round** instead of a 60 s alarm: chunks are short, and a slow round would waste instance
  time.
- **The composition is baked into the image**, not sent with the request. That is a security and licence decision,
  see the README.
- **Jobs, not one long request.** A render is an id you poll. A dropped connection does not lose it.
- **A secret on the endpoint.** Of the projects above, only one small third-party one has any authentication.
- **Mesa in the image** for WebGL on llvmpipe, which nobody else installs. It only pays off for heavy scenes and
  needs a browser build that supports it; it is optional.

## Not adopted

- Passing the composition object from the planning step to every chunk, as Remotion's distributed-rendering page
  recommends and odysseas does. Each chunk calls `selectComposition()` again here. It costs a little time per chunk.
- A warm browser kept open in the container between tasks. Every task starts a fresh browser, so a crash cannot leak
  into the next task; it costs 3 to 7 seconds per chunk.
- Plan v2 of `@hyperframes/producer/distributed` published once to R2 (`planV2WithPublisher()`), instead of every instance planning the composition itself.
