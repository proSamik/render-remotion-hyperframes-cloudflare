# Example: Remotion with a HyperFrames layer

`src/Mixed.tsx` is a Remotion composition. `hyperframes-layer/` is a HyperFrames project with a transparent
background (a lower-third title). The layer is rendered by HyperFrames to a WebM with an alpha channel, and the
Remotion composition plays that file on top of its own content.

How the pre-render, the alpha channel and the cache work: [docs/mixed.md](../../docs/mixed.md).

## Run it

```bash
npm install                       # or `npm run setup` in the repository root. Needs FFmpeg on your PATH.

npm run local                     # layer + bundle + render on this machine          -> out/local.mp4
npm run docker:build && npm run docker                                               # -> out/docker.mp4

npm run deploy                    # layer + bundle + wrangler deploy
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
export RENDER_SERVICE_URL=https://rrh-mixed.<your-subdomain>.workers.dev RENDER_SECRET=<value>
npm run cloud                     # two Cloudflare instances                         -> out/cloud.mp4
```

Different text in the layer (the layer is then rendered at job time, once per instance):

```bash
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs render Mixed --concurrency=2 --out=out/custom.mp4 \
  --props='{"title":"Custom","layerVariables":{"name":"Ada Lovelace","role":"first programmer"}}'
```

## Files

| File | Purpose |
| --- | --- |
| `hyperframes-layer/index.html` | the layer, a normal HyperFrames project |
| `layer.ts` | names the layer file by a hash of its inputs and renders it when missing |
| `engine.ts` | the Remotion engine plus the layer step |
| `prerender-layer.ts` | `npm run layer`: renders the default layer for Studio and for the image |
| `src/Mixed.tsx` | the Remotion composition; plays the layer with `<Video>` from `@remotion/media` |
| `Dockerfile` | both renderers in one image |
