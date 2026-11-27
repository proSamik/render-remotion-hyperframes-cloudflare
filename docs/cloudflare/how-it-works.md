---
id: how-it-works
title: How it works
crumb: 'Cloudflare Containers'
---

# How it works

1. `renderMediaOnCloudflare()` sends `POST /renders` to your Worker with the render options.
2. The Worker creates a Durable Object for the render (`RenderJob`). It answers with a `renderId` at once.
3. The job asks one container instance to open the site and read the composition (`selectComposition()`): size,
   frame rate, length.
4. The job plans equal chunks: `frames / (concurrency x processesPerInstance)`, at least 30 frames.
5. It starts `concurrency` instances. Each runs up to `processesPerInstance` chunk renders at once, each in its own
   process with its own browser. A chunk is one `renderMedia()` call with `codec: 'h264-ts'`, `frameRange`,
   `compositionStart`, `separateAudioTo` and `forSeamlessAacConcatenation`.
6. The job polls the instances every 1.5 seconds from a Durable Object alarm. It collects frame counts, re-queues
   chunks that were lost, replaces instances that hang, and starts a second copy of a straggler.
7. Finished chunks are brought to one instance (directly, or through R2).
8. That instance calls `combineChunks()`.
9. `getRenderProgress()` reads the job's state. `downloadMedia()` streams the result.
10. `deleteRender()` stops what is left and removes the files.

## Differences from Lambda

| | Lambda | Here |
| --- | --- | --- |
| Unit of work | one function invocation per chunk | one process per chunk, several per instance |
| Site | uploaded to S3, downloaded by every function | baked into the container image; or any https URL |
| Coordinator | the main Lambda function | a Durable Object, alive for the length of the render |
| Chunk transport | streamed back to the main function | instance to instance through the coordinator, or R2 |
| Progress | `progress.json` in S3 | Durable Object storage |
| Start-up | function cold start | container cold start; slower when the image is not yet at that location |
| Default chunk | 20 frames or more, up to 200 functions | 30 frames or more, a handful of instances |

Chunks are larger and instances fewer than on Lambda because a container start costs more than a function start.

## Code map

| Part | File |
| --- | --- |
| Public API | `packages/cloudflare-containers/src/api/*.ts` |
| CLI | `packages/cloudflare-containers/src/cli/index.ts` |
| What runs per task in the container | `packages/cloudflare-containers/container/engine.ts` |
| Coordinator (engine-neutral) | `packages/core/src/coordinator.ts` |
| Task server in the container | `packages/core/src/container-server.ts` |
| Worker and Durable Objects | `packages/core/worker/index.ts` |
