# Example: pure HyperFrames

Two small HyperFrames projects, rendered by HyperFrames itself, in the container exactly as on your machine. Remotion
is not involved.

- `composition/`: 8 s, one `index.html` with a GSAP timeline, a font file and a generated sound.
- `long/`: 60 s with a heavier canvas scene from 20 s to 40 s, a frame counter and a flash on every second. Long
  enough that splitting it pays off.

MP4 renders are **split into chunks** that render on several instances and join without a re-encode
([docs/hyperframes-split.md](../../docs/hyperframes-split.md)). `"split": false` renders in one piece with the
`hyperframes render` CLI, as before; other formats always do.

`npx hyperframes check` passes with style warnings: HyperFrames prefers one sub-composition per scene. The examples
keep everything in one file so they are easy to read.

## Run it

```bash
npm install                       # or `npm run setup` in the repository root. Needs FFmpeg on your PATH.

npm run local                     # 8 s, split into 3 chunks on one local instance       -> out/local.mp4
npm run local:cli                 # the same in one piece with `hyperframes render`         -> out/local-cli.mp4
npm run local:long                # 60 s, --chunks auto on 2 local instances x 2 processes -> out/long.mp4
npm run local -- --chunks 4 --instances 4 --processes-per-instance 1                     # any fleet flags
npm run compare                   # one chunk against three: frames, duration, sound, SSIM at the joins
npm run compare:long              # one chunk against four on the 60 s project, with the A/V sync check

npm run docker:build && npm run docker                                                   # -> out/docker.mp4

npm run deploy                    # wrangler deploy (needs Docker and `npx wrangler login`)
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
export RENDER_SERVICE_URL=https://rrh-hyperframes-only.<your-subdomain>.workers.dev RENDER_SECRET=<value>
npm run cloud                     # one Cloudflare instance                                -> out/cloud.mp4
npm run cloud:long                # 60 s, --chunks auto over up to 4 instances             -> out/cloud-long.mp4
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
| `workers` | number or `auto` | split: CPUs / processes per instance; CLI: HyperFrames decides |
| `variables` | values for `data-composition-variables` | |
| `split` | `false` for one `hyperframes render` on one instance | split for MP4 |
| `resolution` | `360p` ... `2160p`, `composition` (split only) | `composition` |
| `crf` | x264 CRF (split only) | from `quality` |
| `keyframeIntervalSeconds` | longest gap between keyframes (split only) | 2 |
| `frameRange` | `[first, last]`, inclusive | the whole video |

Fleet flags (command line) or `fleet` fields (HTTP): `--chunks N|auto` (`chunks`), `--instances N`,
`--processes-per-instance N`, `--chunk-seconds min,max[,heavyMax]` (`chunkSeconds`), `--frames-per-chunk N`,
`--stitch combine|stream|stream-fmp4`.

## Can it be chunked?

Yes, MP4 is chunked by default. Each chunk is a frame range rendered with HyperFrames' own distributed renderer
(`@hyperframes/producer/distributed`, the same version as the CLI), rewrapped as MPEG-TS at its place on the timeline;
the sound is mixed once for the whole video and put under the joined picture, so there is no audio join. Heavy ranges
(`data-render-cost="heavy"`, or a `<canvas>` clip) get shorter chunks with `--chunks auto`. How it works, what your
composition must do (time from the timeline, seeded randomness, fonts in the project) and what was measured:
[docs/hyperframes-split.md](../../docs/hyperframes-split.md).

## Use your own project

Replace `composition/` with your project folder (the one with `index.html`), or add it next to it and copy it in the
Dockerfile. Run `npx hyperframes check` there first, then `npm run compare -- --project <folder>` to see that a
split render gives the same frames as one piece. The example loads GSAP from a CDN and HyperFrames fetches Google Fonts while compiling, so the container
needs outbound Internet (`ENABLE_INTERNET` in `wrangler.jsonc`).

## One thing that differs on Cloudflare

The Dockerfile sets `HYPERFRAMES_BROWSER_PATH`. Without it the render failed on Cloudflare with "Chrome not found",
although the same image rendered in Docker. See [docs/troubleshooting.md](../../docs/troubleshooting.md).
