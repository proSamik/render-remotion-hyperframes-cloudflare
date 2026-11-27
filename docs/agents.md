# Using this from an AI coding agent

Many people now write Remotion or HyperFrames compositions by talking to a coding agent that has the Remotion or
HyperFrames skills installed. The agent renders locally. This page is about the step after that: getting the same
composition rendered on Cloudflare, by the agent.

The short instructions for the agent are in [AGENTS.md](../AGENTS.md) at the repository root. Most agents read that
file by themselves when they open the repository.

## One-time setup by a person

An agent should not do these without you:

1. A Cloudflare account on the Workers Paid plan (Containers are not on the free plan).
2. `npx wrangler login` on the machine the agent works on.
3. Docker running on that machine (wrangler builds the image with it). Or the route in
   [daemonless-deploy.md](daemonless-deploy.md).
4. Clone this repository next to your video project and run `npm run setup`.

## What to tell the agent

Something like:

> Render my composition `LaunchVideo` on Cloudflare using the repository in `../render-remotion-hyperframes-cloudflare`.
> Read its AGENTS.md first. Copy my `src` and `public` into its `examples/remotion-only`, test with `npm run local`,
> then deploy, set a secret, and render with 4 instances. Show me the cost it reports.

For HyperFrames:

> Render the HyperFrames project in `./promo` on Cloudflare with the repository in
> `../render-remotion-hyperframes-cloudflare`. Read its AGENTS.md. Use the hyperframes-only example.

## The loop the agent runs

1. `npm run local` in the example folder. No cloud involved. If this fails, the cloud render will too.
2. `node packages/core/scripts/verify.mjs out/local.mp4 --frames <n>`: frame count, duration, audio present.
3. Look at frames: `ffmpeg -i out/local.mp4 -vf "select=eq(n\,60)" -frames:v 1 frame.png`.
4. `npm run deploy` (asks Cloudflare to build and store the image; the first time takes minutes).
5. Set the secret once: `openssl rand -hex 24 | npx wrangler secret put RENDER_SECRET`. The agent must keep the
   value somewhere that is not committed, for example a `.env` file (ignored by `.gitignore` here).
6. `npm run cloud`, or the CLI with options. The CLI prints progress lines and a final JSON document with `out`,
   `frames`, `seconds` and `costs`.
7. Verify the downloaded file as in step 2.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `RENDER_SERVICE_URL` or `REMOTION_CLOUDFLARE_SERVICE_URL` | the URL `wrangler deploy` printed |
| `RENDER_SECRET` or `REMOTION_CLOUDFLARE_SECRET` | the value given to `wrangler secret put RENDER_SECRET` |

## From code instead of the command line

```ts
import { renderMediaOnCloudflare, getRenderProgress, downloadMedia, deleteRender } from '../packages/cloudflare-containers/src/client.ts';

const { renderId } = await renderMediaOnCloudflare({ composition: 'Shapes', inputProps: { title: 'Hello', durationInSeconds: 10 }, concurrency: 2 });
for (;;) {
  const progress = await getRenderProgress({ renderId });
  if (progress.fatalErrorEncountered) throw new Error(progress.errors.map((error) => error.message).join('\n'));
  if (progress.done) break;
  await new Promise((done) => setTimeout(done, 2000));
}
await downloadMedia({ renderId, outPath: 'out/video.mp4' });
await deleteRender({ renderId });
```

The package is not on npm. Import it by path, or copy `packages/` into your project.

## Things agents get wrong

- Starting a second render because the first "looks stuck". A cold instance can take a minute or two when the image
  is pulled at a new location. Poll; do not restart.
- Forgetting `--webgl` for three.js. Without it Chromium falls back to its slowest software renderer.
- Using `Date.now()`, `Math.random()` or wall-clock animation in a composition. Each chunk is a separate browser on a
  separate machine. Everything visible must depend on the frame number only.
- Fonts that only exist on the developer's machine.
- Committing the secret or the service URL.
