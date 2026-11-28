---
id: setup
title: Setup
crumb: 'Cloudflare Containers'
---

# Setup

The complete walk-through from a new Cloudflare account to teardown, with every pitfall we hit, is
[docs/setup.md](../setup.md). This page is the short form for the Remotion package.

## 1. Requirements

- A Cloudflare account on the Workers Paid plan. Containers are not available on the free plan.
- Node.js 22.18 or newer.
- Docker running on your machine. Wrangler uses it to build the image. (No Docker: see
  [daemonless-deploy.md](../daemonless-deploy.md).)

## 2. Get the code

The package is not on npm. Clone the repository and work in a copy of the Remotion example:

```bash
git clone https://github.com/proSamik/render-remotion-hyperframes-cloudflare
cd render-remotion-hyperframes-cloudflare
npm run setup
cd examples/remotion-only
```

Replace `src/` and `public/` with your project, or keep the example for a first run. Keep `remotion` and every
`@remotion/*` package on one version.

## 3. Render locally

```bash
npm run local
```

This bundles the project and renders `out/local.mp4` with the same coordinator and task server that run on
Cloudflare, as processes on your machine.

## 4. Log in to Cloudflare

```bash
npx wrangler login
```

## 5. Create a site

```bash
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs sites create src/index.ts --site-name=site
```

A site is your bundled project. It is written to `build/sites/site` and baked into the image by the next step.

## 6. Deploy the service

```bash
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs services deploy
```

This runs `wrangler deploy`: it uploads the Worker, builds the image from `Dockerfile` and pushes it. The command
prints the service URL. `npm run deploy` does steps 5 and 6.

## 7. Set the secret

```bash
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
```

The value is printed once on your terminal. Keep it. Until a secret is set the service refuses every request.

## 8. Render

```bash
export REMOTION_CLOUDFLARE_SERVICE_URL=https://rrh-remotion-only.<your-subdomain>.workers.dev
export REMOTION_CLOUDFLARE_SECRET=<the secret>
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs render Shapes --concurrency=2 --out=out/cloud.mp4
```

Or from code: [renderMediaOnCloudflare()](rendermediaoncloudflare.md).

## 9. Check

```bash
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs doctor
node ../../packages/core/scripts/verify.mjs out/cloud.mp4 --frames 300
```

## Optional: R2

Without R2, chunks travel between instances and the output is streamed from the instance that joined it. With an R2
bucket, chunks and outputs are stored there. See [r2.md](../r2.md).

## Uninstall

```bash
npx wrangler containers list                 # note the ID first
npx wrangler delete                          # the Worker (the container application stays and bills until the next line)
npx wrangler containers delete <id>
npx wrangler containers images list          # then: npx wrangler containers images delete <image>:<tag>
```

Bucket, token and the rest: [docs/setup.md, section 12](../setup.md#12-teardown).
