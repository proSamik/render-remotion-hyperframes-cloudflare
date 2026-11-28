# For AI coding agents

You are probably here because the person you work for writes video with Remotion or HyperFrames (often through agent
skills) and wants it rendered in the cloud, on their own Cloudflare account. This file tells you how. Longer version:
[docs/agents.md](docs/agents.md).

## Pick the example

| Their code | Use | Folder |
| --- | --- | --- |
| Remotion only (React, `registerRoot`, `<Composition>`) | Remotion SSR, chunked | `examples/remotion-only` |
| HyperFrames only (`index.html` with `data-composition-id`, GSAP timeline) | HyperFrames' own renderer | `examples/hyperframes-only` |
| Remotion with a HyperFrames-made layer | pre-render the layer, composite in Remotion | `examples/mixed` |

## Rules

- Render their own code on their own Cloudflare account. Do not build a service where other people upload Remotion
  code: Remotion's terms forbid that without written approval (README, "Licences").
- Never print or commit the endpoint secret, the account id, or a `workers.dev` URL into files under version control.
- A render costs money. Do not start more than one test render without saying so. Delete each render when you have
  the file (the CLI does).
- Do not deploy without being asked. `wrangler deploy` needs a logged-in wrangler and a running Docker.
- Node 22.18 or newer. Run every command from the folder named in it.

## Commands

Setup, once, from the repository root:

```bash
npm run setup
```

Render locally first. It needs no Cloudflare account and proves the composition works:

```bash
cd examples/remotion-only    && npm run local      # out/local.mp4
cd examples/hyperframes-only && npm run local      # out/local.mp4
cd examples/mixed            && npm run local      # out/local.mp4
```

Check a result (needs ffmpeg and ffprobe):

```bash
node packages/core/scripts/verify.mjs <file> --frames <expected frame count>
```

Deploy (only when asked), from an example folder:

```bash
openssl rand -hex 24 | npx wrangler secret put RENDER_SECRET     # after the first deploy; keep the value
npm run deploy                                                   # prints the service URL
```

Render in the cloud:

```bash
export RENDER_SERVICE_URL=https://<name>.<subdomain>.workers.dev
export RENDER_SECRET=<the secret>
cd examples/remotion-only && npm run cloud                       # out/cloud.mp4
```

With options (Remotion):

```bash
node packages/cloudflare-containers/bin/remotion-cloudflare.mjs render <CompositionId> \
  --props='{"title":"Hello"}' --concurrency=4 --out=out/video.mp4
```

Add `--webgl` when the composition uses three.js, shaders or any WebGL. For a video whose chunks plus output would
not fit one 20 GB disk (more than about an hour of 1080p), add `--stitch=stream` and read
[docs/long-videos.md](docs/long-videos.md) first: that path has not run on Cloudflare in this repository.

## HTTP, if you cannot run Node

Every request needs `Authorization: Bearer $RENDER_SECRET`.

```bash
# start
curl -sX POST "$RENDER_SERVICE_URL/renders" -H "Authorization: Bearer $RENDER_SECRET" -H 'content-type: application/json' \
  -d '{"render":{"composition":"Shapes","inputProps":{"title":"Hello","durationInSeconds":10}},"fleet":{"instances":2}}'
# -> {"renderId":"r0123456789ab"}

# poll every 2 s until "done": true. Stop on "fatalErrorEncountered": true and read "errors".
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "Authorization: Bearer $RENDER_SECRET"

# download, then delete
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab/output" -H "Authorization: Bearer $RENDER_SECRET" -o video.mp4
curl -sX DELETE "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "Authorization: Bearer $RENDER_SECRET"
```

HyperFrames body: `{"render":{"project":"composition","quality":"looks"}}`.
Compare the SHA-256 of the download with `outputSha256` from the progress.

## Putting their composition in

- Remotion: replace `examples/remotion-only/src` and `public` with theirs (or copy the folder), keep `Dockerfile`,
  `wrangler.jsonc` and the scripts. Pin `remotion` and every `@remotion/*` package to the same version. Then
  `npm run local`, then `npm run deploy`. A new composition needs a new deploy: the bundle is in the image.
- HyperFrames: replace `examples/hyperframes-only/composition` with their project folder. Run
  `npx hyperframes check` in it first.
- Fonts: the container has no Mac or Windows fonts. Put font files in the project. See [docs/fonts.md](docs/fonts.md).
- Media: files under `public/` (Remotion) or `assets/` (HyperFrames) go into the image. Remote media must be
  reachable from the container over https.

## When it fails

Read `errors` in the progress first. Each entry has a `kind` (`chunk_failed`, `chunk_deadline`, `checksum_mismatch`,
`job_failed`, ...) and `fatal`. Entries with `fatal: false` were recovered from; do not report them as failures.
Then [docs/troubleshooting.md](docs/troubleshooting.md). `overallProgress` never goes back, so a number that waits is
work being repeated, not a hang; a render that is stuck ends by itself with `fatalErrorEncountered: true`.
