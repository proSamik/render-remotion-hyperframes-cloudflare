# One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/proSamik/render-remotion-hyperframes-cloudflare)

The button deploys the **render service of the repository root** (`wrangler.jsonc`, `deploy/Dockerfile`): one Worker,
one container image with Remotion, HyperFrames and the mix, an R2 bucket, and the HTTP API of [api.md](api.md). It
renders the example compositions of `examples/` until you put yours in.

**What was validated, 2026-11-28.** Not the button itself (it needs a person to connect a Git account in the
browser) but what it runs, under a throw-away name: `npm ci` in a clean copy of the repository root, the Docker build
of `deploy/Dockerfile` on a Linux machine (all three engines answered a plan request in the built image), and
`wrangler deploy` of the root `wrangler.jsonc` with that image pushed to the account's registry (the bucket was
created by the deploy). Then over the API, with `clients/render-client.mjs`: `/health`; an upload, fetched back
through its signed link (a changed signature answered `403`) and deleted; a 5 s Remotion render at 480p on the
economy tier (0:38 from request to done, 854x480; the first render after the deploy, so 0:23 of it was the instance start); the 8 s HyperFrames example split into 3 chunks (0:29); the mixed
example (frames 0-89 on the economy tier, 0:26, with its pre-rendered layer); a cancel during rendering (phase `failed`, `job_cancelled`, 0 instances); every download
through `/link` without the secret and checked against `outputSha256`. Then everything was deleted.

**Licence.** You deploy this to your own account and render your own code. Remotion's licence applies to you as the
deployer (free for individuals and companies up to 3 people). Do not turn the deployment into a service where other
people upload their own Remotion code: Remotion's terms forbid that without their written approval
([README, Licences](../README.md#licences)).

## What you do, step by step

1. **Account**: a Cloudflare account on **Workers Paid** ($5 a month; Containers are not on the Free plan) and a
   GitHub or GitLab account. Your Cloudflare user needs *Workers Scripts: Edit*, *Containers: Edit* and *Workers R2
   Storage: Edit* (an account Super Administrator has them).
2. **Click the button** above. Cloudflare asks you to log in and to connect GitHub (or GitLab).
3. **Name things.** The page proposes:
   - a repository name: Cloudflare creates a copy of this repository in your Git account, and later pushes to it
     deploy again;
   - a Worker name (`render-remotion-hyperframes`): your service URL becomes
     `https://<worker name>.<your subdomain>.workers.dev`;
   - an R2 bucket (`render-remotion-hyperframes`): created for you. Pick a new name if you have one by that name.
4. **Set the secret.** `RENDER_SECRET`: the key every request must send. Make one on your machine with
   `openssl rand -hex 24` and keep it in a password manager. At least 16 characters.
5. **Leave the variables** as proposed, or lower `MAX_INSTANCES_PER_RENDER` (your spend limit per render).
6. **Leave build and deploy commands** as detected (no build command; deploy `npm run deploy`, which is
   `wrangler deploy`). Click **Create and deploy**.
7. **Wait.** Workers Builds installs, builds the container image from `deploy/Dockerfile` (it bundles the Remotion
   compositions and pre-renders the mixed layer inside the build), pushes it and deploys. The first build takes a while: the image is about 2.2 GB (two Chrome builds, FFmpeg, fonts, Mesa). The build log
   is in the dashboard under your Worker, *Deployments* / *Builds*.
8. **Wait one more minute** after it says deployed: the image is still being copied to Cloudflare's locations, and
   starts right after a deploy can hang (the service retries; a first render is just slower).
9. **Test it** (from your machine):

   ```bash
   export RENDER_SERVICE_URL=https://<worker name>.<your subdomain>.workers.dev
   export RENDER_SECRET=<the secret of step 4>
   curl -s "$RENDER_SERVICE_URL/health" -H "Authorization: Bearer $RENDER_SECRET"
   curl -s -X POST "$RENDER_SERVICE_URL/renders" -H "Authorization: Bearer $RENDER_SECRET" -H 'content-type: application/json' \
     -d '{"engine":"remotion","composition":"Shapes","inputProps":{"durationInSeconds":5},"tier":"economy"}'
   # then GET /renders/<renderId> until "done": true, GET /renders/<renderId>/output, DELETE /renders/<renderId>
   ```

   All routes: [api.md](api.md).
10. **Set a budget alert**: dashboard, *Manage Account*, *Billing*, *Billable Usage*, budget alert. It e-mails you; it
    does not stop anything ([setup.md](setup.md#10-what-it-costs-and-how-to-watch-it)).

## Put your own compositions in

In the repository the button created for you:

- **Remotion**: replace `examples/remotion-only/src` and `public` with your project (keep `remotion` and every
  `@remotion/*` on version 4.0.530, or change all of them together, also in `deploy/package.json`). The image bundles
  `src/index.ts`. Render with `"engine": "remotion", "composition": "<your id>"`.
- **HyperFrames**: put your project folder next to `examples/hyperframes-only/composition` and add one `COPY` line
  for it to `deploy/Dockerfile` (as for `long`). Render with `"engine": "hyperframes", "composition": "<folder>"`.
  Check it first: `npx hyperframes check`, and `npm run compare -- --project <folder>` in
  `examples/hyperframes-only` ([hyperframes-split.md](hyperframes-split.md)).
- Push. Workers Builds builds and deploys again. Every composition change is a new image.

## What the button does, as commands

The same thing by hand, from a clone (Docker running, or `DOCKER_HOST` pointing at a machine with Docker,
[setup.md](setup.md#building-the-image-elsewhere)):

```bash
npm ci
# edit wrangler.jsonc: "name", "bucket_name", "SERVICE_NAME" if you want other names
npx wrangler r2 bucket create render-remotion-hyperframes
npm run deploy                                                    # = wrangler deploy: builds deploy/Dockerfile, pushes, deploys
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
```

`wrangler deploy` creates the bucket named in `r2_buckets` if it does not exist ("Resources provisioned"), so the
`r2 bucket create` line is optional. No Docker on this machine: [setup.md](setup.md#building-the-image-elsewhere).

Teardown: [setup.md, section 12](setup.md#12-teardown); the Worker is `render-remotion-hyperframes`, the bucket the one
you named, and the repository the button created is yours to delete on GitHub.

## Facts this relies on

From https://developers.cloudflare.com/workers/platform/deploy-buttons/ and the Containers docs, read 2026-11-28:

- The button deploys a Workers application from a public GitHub or GitLab repository; a subdirectory must be
  self-contained, so the service lives at the repository root.
- Resources named in `wrangler.jsonc` (here the R2 bucket) are provisioned; secrets are read from
  `.dev.vars.example`; descriptions come from `cloudflare.bindings` in `package.json`.
- A `deploy` script in `package.json` becomes the deploy command. Workers Builds runs Dockerfile builds for
  Containers ("Dockerfile builds can run in the Workers Builds environment").
