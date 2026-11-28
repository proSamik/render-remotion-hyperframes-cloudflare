# Troubleshooting

Start with the `errors` array of the progress (`GET /renders/<id>`). The render process's own message is in there.

## Setup

**`Unknown file extension ".ts"`**
Your Node cannot run TypeScript files. Node 22.18 or newer from nodejs.org, nvm or the official Docker images can.
Some distribution packages are built without it (we hit this with a distribution's Node 22.22). The command line
tools here fall back to `tsx` when you ran `npm install` in the repository root.

**`could not start an instance: ... docker`**
Docker is not running, or the image name after `--docker=` does not exist. Build it first: `npm run docker:build`.

**`COPY examples/.../build/sites: not found` during the image build**
The bundle is made before the image: run `npm run site` (the `deploy` and `docker:build` scripts do).

**`403 forbidden` from the service**
No secret, a wrong one, or one shorter than 16 characters. `npx wrangler secret put RENDER_SECRET`, then pass the
same value as `RENDER_SECRET`.

**The first render after a deploy hangs in `planning`**
Cloudflare is still distributing the image. Wait a few minutes. A render gives up after 15 minutes without an
instance.

## Remotion

**`TypeError: error is not a function` at `new WebGLRenderer`**
three.js could not get a WebGL context and its own error path failed. In a container this is `gl: 'angle-egl'` with
Remotion's bundled browser, or `gl: 'angle'`. Use `webgl: true` and let the engine choose, or `--gl=swangle`. See
[gl-backends.md](gl-backends.md).

**WebGL worked last month and fails after an image rebuild**
The browser changed. A browser that is downloaded at build time without a pinned version is a different browser
after the next build, and `angle-egl` works in some builds and not in others. Pin the version in one place and run
`packages/core/scripts/webgl-selftest.mjs` as the last build step and at start. See
[gl-backends.md](gl-backends.md#pin-the-browser-in-one-place-and-prove-it).

**Every request to an instance answers `503` with `"selftest": "failed"`**
`RENDER_SELFTEST` is set and the command ended with an error. The `output` field of the answer has its last lines.
The instance will not take work; fix the image.

**Text is missing or in the wrong font**
The image has no such font. See [fonts.md](fonts.md).

**`site "x" is not in this image`**
`serveUrl` names a site that was not bundled before the deploy. Sites live in `build/sites/<name>`.

**A `delayRender()` timeout**
Something the composition waits for did not arrive in time: a font or media from the network with
`ENABLE_INTERNET` off, or a slow host. Raise `timeoutInMilliseconds`.

**The video and the Studio preview differ**
Check for `Date.now()`, `Math.random()`, CSS animations and transitions, or anything else that does not depend on
`useCurrentFrame()`. Each chunk is a different browser on a different machine.

**A click or a gap in the sound at regular intervals**
That would be a broken join. Check that every chunk got the same `compositionStart` and that you did not change
`framesPerChunk` between rendering and stitching. `packages/core/scripts/verify.mjs --joins` finds it.

## HyperFrames

**`Chrome not found` on Cloudflare, although the image has it**
HyperFrames refused its download cache with the message "/ can be changed by another user account". This happened
on Cloudflare and not in Docker. Set `HYPERFRAMES_BROWSER_PATH` (and `PRODUCER_HEADLESS_SHELL_PATH`) to the browser
binary. The example Dockerfiles do.

**HyperFrames and Remotion render WebGL differently in the same image**
They run different browsers. Point `HYPERFRAMES_BROWSER_PATH`, `PRODUCER_HEADLESS_SHELL_PATH` and
`REMOTION_WEBGL_BROWSER_EXECUTABLE` at the same pinned binary.

**`hyperframes render ended with code 1`**
The tail of the CLI output is in the error. Run `npx hyperframes check` in the project locally first.

**The render waits a long time and frames are static**
A scene host id that differs from its scene's id, or a timeline not registered under the composition id
(`window.__timelines["<data-composition-id>"]`).

## Cloudflare

**`the instance that held the output is gone (410)`**
Without R2 the output lives on one instance. It stopped (inactivity, 15 minutes after the render, or a restart)
before you downloaded. Download right after the render, or attach R2.

**`fleet.instances must be 1 to 4`**
`MAX_INSTANCES_PER_RENDER` in `wrangler.jsonc`.

**A transfer "arrived damaged"** (`kind: "checksum_mismatch"`)
A file changed on the way between instances. The coordinator repeats the transfer; you only see the note in
`errors`. If it keeps happening, attach R2.

**`stitch failed: ... arrived damaged`**
A chunk fetched for the join did not have the size or SHA-256 recorded where it was rendered. It was fetched 4 times.
The join is tried 3 times, then the render fails. Nothing wrong was joined. Look at the bucket: an object that was
overwritten or cut short by something outside this service.

**`hedge: second run started for a slow chunk`**
Not an error. A chunk rendered at under half the usual speed and a free slot rendered it a second time. If
`hedges.started` is high and `hedges.won` stays 0, your hosts are even and hedging only costs: set
`duplicateStragglers: false`.

**`the joined video has N frames, expected M`**
The streaming join counted what the muxer wrote and it is not the render's frame count. A chunk is not what the
coordinator thinks it is: mixed-up `framesPerChunk`, or chunk files from another render in the same folder.

**Progress stays at the same percentage for a while**
Chunks are being rendered again (an instance restarted). The percentage never goes back; `framesRendered` shows the
real count. See [progress.md](progress.md).

**Costs higher than expected**
Instances that were never stopped. `DELETE /renders/<id>` after each render; check
`npx wrangler containers list` for live instances.

## Image size

| Image | Size (uncompressed, as built by us) | Compressed |
| --- | --- | --- |
| Remotion only | 1.27 GB | 334 MB |
| HyperFrames only | 1.67 GB | 444 MB |
| Mixed | 2.11 GB | 565 MB |

Size matters for the slow kind of cold start. Things that make it smaller: drop the Mesa packages if you have no
WebGL; drop `fonts-noto-core` if you ship your own fonts; replace Debian's `ffmpeg` (which pulls in many codecs) by
a static build, as HyperFrames' own images do; keep large media out of `public/`.

## Still stuck

Render the same thing locally (`--local`), then in Docker (`--docker=<image>`). The three use the same coordinator
and the same task server, so the step where it starts to fail tells you where the problem is.
