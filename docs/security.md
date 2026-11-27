# Security notes

This is a guide for rendering **your own code on your own Cloudflare account**. It is not a design for a public
render service.

## The endpoint

- Every request needs `Authorization: Bearer <RENDER_SECRET>`. The Worker compares in constant time and refuses
  everything when the secret is unset or shorter than 16 characters. A fresh deploy without a secret answers 403 to
  all requests.
- Set it with `openssl rand -hex 24 | npx wrangler secret put RENDER_SECRET`. Do not put it in `wrangler.jsonc`
  `vars`: those are plain text and get committed.
- The URL is public (`*.workers.dev`). The secret is the only thing between the Internet and your bill. For anything
  more than personal use, put Cloudflare Access or your own authenticated backend in front and keep the secret
  server-side. Never ship it in a browser or a mobile app.
- There is no rate limit and no queue. Whoever holds the secret can start renders until the account limit.
  `MAX_INSTANCES_PER_RENDER` caps one render, not the number of renders.

## What a request can do

- A request chooses a composition and input props. It cannot choose code: the bundle or the HyperFrames project is
  baked into the image at deploy time.
- `serveUrl` may also be an `https://` URL. Then the container loads and runs whatever JavaScript is there. Only
  pass URLs you control. If your callers are not you, remove that branch in `resolveServeUrl()`.
- Site names, project names, job ids and file names are matched against strict patterns before they touch the file
  system. There is a unit test for path traversal in `serveUrl`.
- Input props are data, but your composition decides what it does with them. A composition that fetches a URL from
  its props will fetch any URL a caller sends, from inside your container.

## Other people's code

Do not run it here.

- Legally: Remotion's terms forbid "a rendering service that allows end-users to bring or upload their own Remotion
  code" without written approval (see the README).
- Technically: the code runs in a Chromium that this setup starts **without its sandbox** (`--no-sandbox`; Remotion
  and HyperFrames both do this in containers), in a container where, with the `durable_object` scheduling policy,
  "every process has the same Linux capabilities as root, regardless of user" (Cloudflare's API docs). The isolation
  you get is the instance: each instance is its own micro virtual machine with its own kernel. Instances are never
  shared between renders. That protects renders from each other. It does not make hostile code safe to run with
  outbound Internet and access to whatever you put in the image.

If your compositions load nothing from the network, set `ENABLE_INTERNET` to `"false"`. Then a container can reach
only what you intercept for it (R2). The HyperFrames examples need the Internet for GSAP from the CDN and for Google
Fonts unless you vendor both.

## Secrets and the image

- Nothing secret goes into the image. Anyone with access to your registry can read every layer.
- The containers get no Cloudflare credentials. With R2 they reach the bucket through the Worker, which serves only
  keys under the render's own prefix.
- Presigned URLs need R2 S3 keys. They live in Worker secrets and never reach a container.
- `CONTAINER_ENV` is a plain variable. Do not put secrets in it.

## Files

- Outputs without R2 live on one instance until you delete the render or it times out.
- With R2, outputs stay in the bucket until you delete the render. Add a lifecycle rule.
- A render id is 12 random hex characters. It is not a secret; the bearer token is.

## Checklist before you rely on this

1. `RENDER_SECRET` set, 32 characters or more, stored somewhere safe.
2. `MAX_INSTANCES_PER_RENDER` as low as you can live with.
3. A billing alert on the Cloudflare account.
4. No `https://` serve URLs unless you need them.
5. Your own rate limit if anything but you calls the service.
