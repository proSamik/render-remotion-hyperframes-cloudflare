# Example: pure HyperFrames

`composition/` is a small HyperFrames project: one `index.html` with a GSAP timeline, a font file and a generated
sound. It is rendered by HyperFrames' own renderer (`hyperframes render`), in the container exactly as on your
machine. Remotion is not involved.

`npx hyperframes check` passes with two style warnings: HyperFrames prefers one sub-composition per scene. The
example keeps everything in one file so it is easy to read.

## Run it

```bash
npm install                       # or `npm run setup` in the repository root. Needs FFmpeg on your PATH.

npm run local                     # render on this machine through the coordinator   -> out/local.mp4
npm run docker:build && npm run docker                                               # -> out/docker.mp4

npm run deploy                    # wrangler deploy (needs Docker and `npx wrangler login`)
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
export RENDER_SERVICE_URL=https://rrh-hyperframes-only.<your-subdomain>.workers.dev RENDER_SECRET=<value>
npm run cloud                     # one Cloudflare instance                           -> out/cloud.mp4
```

Options go in the render JSON:

```bash
node ../../packages/core/bin/render.mjs cloud --out=out/custom.mp4 \
  --render='{"project":"composition","quality":"delivery","fps":30,"variables":{"headline":"Your own headline"}}'
```

| Field | Values | Default |
| --- | --- | --- |
| `project` | a folder under `/app/projects` in the image | `composition` |
| `quality` | `draft`, `looks`, `standard`, `high`, `delivery` | `looks` |
| `format` | `mp4`, `webm`, `mov` (the last two keep transparency) | `mp4` |
| `fps` | number | 30 |
| `workers` | number or `auto` | HyperFrames decides |
| `variables` | values for `data-composition-variables` | |

## Can it be chunked?

Not by this repository. `hyperframes render` uses several browser workers inside one machine, and one container
instance is that machine. Asking for more instances changes nothing. For many videos, start many renders. For one
long video, HyperFrames has distributed rendering of its own (`@hyperframes/producer/distributed`, used by
`hyperframes lambda` and `hyperframes cloudrun`); connecting it to this coordinator is not done.
See [docs/chunking.md](../../docs/chunking.md).

## Use your own project

Replace `composition/` with your project folder (the one with `index.html`). Run `npx hyperframes check` there
first. The example loads GSAP from a CDN and HyperFrames fetches Google Fonts while compiling, so the container
needs outbound Internet (`ENABLE_INTERNET` in `wrangler.jsonc`).

## One thing that differs on Cloudflare

The Dockerfile sets `HYPERFRAMES_BROWSER_PATH`. Without it the render failed on Cloudflare with "Chrome not found",
although the same image rendered in Docker. See [docs/troubleshooting.md](../../docs/troubleshooting.md).
