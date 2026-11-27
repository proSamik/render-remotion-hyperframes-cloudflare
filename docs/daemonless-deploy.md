# Appendix: deploying without a local Docker daemon

The normal route is `npm run deploy` on a machine where Docker runs: wrangler builds the image and pushes it. Use
that if you can.

This appendix is for the case we were in: the machine with wrangler has no Docker daemon, and a second machine (any
x86-64 Linux box) has one. We deployed every Cloudflare test of this guide this way.

You need `crane` on the wrangler machine (https://github.com/google/go-containerregistry, `brew install crane`).

1. On the Docker machine, from the repository root (after `npm run site` in the example folder, so the bundle
   exists):

   ```bash
   docker build --platform linux/amd64 -f examples/remotion-only/Dockerfile -t rrh-remotion-only .
   docker save rrh-remotion-only -o remotion.tar
   ```

   Copy `remotion.tar` to the wrangler machine. It must be an uncompressed tar: `crane` did not read a gzipped one.

2. On the wrangler machine, log `crane` in to Cloudflare's registry with a short-lived password and push:

   ```bash
   npx wrangler containers registries credentials registry.cloudflare.com --push --pull \
     | tail -1 | crane auth login registry.cloudflare.com -u v1 --password-stdin
   crane push remotion.tar registry.cloudflare.com/<ACCOUNT_ID>/rrh-remotion-only:v1
   crane digest registry.cloudflare.com/<ACCOUNT_ID>/rrh-remotion-only:v1
   ```

   `<ACCOUNT_ID>` is shown by `npx wrangler whoami`.

3. Point the example's `wrangler.jsonc` at the pushed image instead of the Dockerfile. With the `durable_object`
   scheduling policy the reference must be pinned by digest:

   ```jsonc
   "images": { "render": { "image": "registry.cloudflare.com/<ACCOUNT_ID>/rrh-remotion-only@sha256:<DIGEST>" } }
   ```

4. `npx wrangler deploy`. No Docker is needed for a registry reference.

5. When you are done: `crane auth logout registry.cloudflare.com`.

Do not commit a `wrangler.jsonc` that contains your account id.

If both machines can reach the Internet, `npx wrangler containers build -p -t <tag> .` on the Docker machine does
steps 1 and 2 in one, provided wrangler is logged in there.

Cleaning up: `npx wrangler containers images list`, `npx wrangler containers images delete <image>:<tag>`,
`npx wrangler delete` for the Worker, `npx wrangler containers list` and `npx wrangler containers delete <id>` for
the container application.
