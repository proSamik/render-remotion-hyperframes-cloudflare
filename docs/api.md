# HTTP API

The render service (the Deploy button's service, or any example's) answers plain HTTP. Every request carries
`Authorization: Bearer $RENDER_SECRET`, except the signed links it hands out. Machine-readable:
[openapi.yaml](openapi.yaml). A dependency-free JavaScript client: [clients/render-client.mjs](../clients/render-client.mjs).

```bash
export RENDER_SERVICE_URL=https://<name>.<your-subdomain>.workers.dev
export RENDER_SECRET=<the secret you set>
AUTH="Authorization: Bearer $RENDER_SECRET"
```

**What you may render.** Your own code, on your own account: the compositions are bundled into the image when you
deploy, and a request only names one and passes values to it. Remotion's terms do not allow a service where other
people upload their own Remotion code ([README, Licences](../README.md#licences)). Uploads below are input files
(images, video, sound, data), never code.

## Check

```bash
curl -s "$RENDER_SERVICE_URL/health" -H "$AUTH"
# {"ok":true,"service":"render-remotion-hyperframes","storage":true,"instanceType":"standard-4","maxInstancesPerRender":4}
```

## Upload an input file (optional)

```bash
curl -s -X PUT "$RENDER_SERVICE_URL/uploads/photo.jpg" -H "$AUTH" -H 'content-type: image/jpeg' --data-binary @photo.jpg
# {"uploadId":"3f2a...","name":"photo.jpg","bytes":48211,"url":"https://.../files/uploads/3f2a.../photo.jpg?expires=...&sig=..."}
```

Pass `url` to the composition (`inputProps` for Remotion, `variables` for HyperFrames): the container fetches it like
any https URL, and the link works for 7 days without the secret. Up to 100 MB per file (a Worker's request body
limit); needs the R2 bucket. `DELETE /uploads/<uploadId>` removes it.

## Start a render

The short form:

```bash
curl -s -X POST "$RENDER_SERVICE_URL/renders" -H "$AUTH" -H 'content-type: application/json' -d '{
  "engine": "remotion",
  "composition": "Shapes",
  "inputProps": { "title": "Hello", "durationInSeconds": 10 },
  "range": [0, 149],
  "quality": "720p",
  "tier": "standard"
}'
# {"renderId":"r0123456789ab"}
```

| Field | Values | Default |
| --- | --- | --- |
| `engine` | `remotion`, `hyperframes`, `mixed` | required |
| `composition` | Remotion and mixed: the composition id. HyperFrames: the project folder in the image | `Shapes`, `composition`, `Mixed` |
| `inputProps` | object, Remotion and mixed | `{}` |
| `variables` | object, HyperFrames (`data-composition-variables`) | |
| `range` | `[first, last]` frame, both included | the whole composition |
| `quality` | output size: `360p`, `480p`, `720p`, `1080p`, `1440p`, `2160p` (`2k`, `4k`), `composition` | `composition` |
| `tier` | `economy` (1 instance), `standard` (2), `fast` (4); never more than `MAX_INSTANCES_PER_RENDER` | `standard` |
| `preset` | HyperFrames encoder preset: `draft`, `looks`, `standard`, `high`, `delivery` | `looks` |
| `format` | HyperFrames: `mp4` (split over instances), `webm`, `mov` (one piece, alpha) | `mp4` |

HyperFrames:

```bash
curl -s -X POST "$RENDER_SERVICE_URL/renders" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"engine":"hyperframes","composition":"composition","quality":"480p","preset":"draft","tier":"economy"}'
```

Every option of the engines and the coordinator is in the full form, `{ "render": {...}, "fleet": {...} }`
([AGENTS.md](../AGENTS.md#http-if-you-cannot-run-node), [rendermediaoncloudflare.md](cloudflare/rendermediaoncloudflare.md)).
A body with `engine` at the top level is the short form.

## Progress

```bash
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "$AUTH"
```

```json
{ "renderId": "r0123456789ab", "done": false, "percent": 42, "overallProgress": 0.423, "phase": "rendering",
  "framesRendered": 128, "frames": 300, "chunks": { "total": 6, "rendered": 2, "stored": 2, "running": 4 },
  "instances": 2, "fatalErrorEncountered": false, "errors": [],
  "outputSizeInBytes": null, "outputSha256": null, "timeToFinish": null,
  "costs": { "accruedSoFar": 0.0011, "currency": "USD", "cpuSeconds": 41.5, "instanceSeconds": 27.1 } }
```

Phases, in order: `planning` (an instance starts and reads the composition: size, length, frame rate), `rendering`
(chunks on the instances; `framesRendered` counts), `stitching` (one instance joins the chunks without a re-encode),
`done`. Or `failed`, with the reason in `errors` (`fatal: true`). `percent` never goes back: when a chunk is rendered
again after a lost instance, it waits. Entries with `fatal: false` were recovered from. Poll every 2 seconds.

## Download

```bash
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab/output" -H "$AUTH" -o video.mp4        # with the secret
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab/link?expires=3600" -H "$AUTH"          # a link without it
# {"url":"https://.../renders/r0123456789ab/output?expires=...&sig=..."}
```

Compare `sha256sum video.mp4` with `outputSha256`. With R2 S3 keys on the service, `output?presign=3600` gives a
link straight to R2 instead (docs/r2.md); downloads from R2 have no egress fee either way.

## Cancel, delete

```bash
curl -s -X POST "$RENDER_SERVICE_URL/renders/r0123456789ab/cancel" -H "$AUTH"   # stops it; progress stays readable
curl -s -X DELETE "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "$AUTH"        # stops it and deletes its files
```

Delete every render when you have the file. Without that, a finished render's instance is stopped after 15 minutes
anyway, but its files stay in R2.

## JavaScript

```js
import { RenderClient } from './render-client.mjs';

const client = new RenderClient(process.env.RENDER_SERVICE_URL, process.env.RENDER_SECRET);
const { renderId } = await client.render({ engine: 'hyperframes', composition: 'composition', quality: '480p', tier: 'economy' });
await client.wait(renderId, (progress) => console.log(`${progress.percent} % ${progress.phase}`));
await client.download(renderId, 'video.mp4');      // checks the SHA-256
await client.delete(renderId);
```

## Errors

| Status | Meaning |
| --- | --- |
| `400` | the body is not a render request; `error` says what is wrong |
| `403` | no secret, a wrong one, or an expired or altered link |
| `404` | no such render (deleted, or never started) |
| `409` | no output yet |
| `410` | without R2: the instance that held the output is gone; render again |
| `501` | the route needs the R2 bucket (uploads) or R2 S3 keys (`presign`) |
