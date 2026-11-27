# Contributing

This is a guide first and a code base second. The most useful contributions:

1. **What broke for you.** Open an issue with the command, the `errors` array of the render's progress, and where it
   ran (local, Docker, Cloudflare).
2. **Numbers.** Your content type, instance count, `costs` from the result, and what the Cloudflare bill said.
3. **Things marked "not run"** in the README that you ran: presigned URLs, large outputs, more instances, a deploy
   built by wrangler with local Docker.

## Working on the code

```bash
npm run setup
npm run typecheck && npx tsc --noEmit -p packages/core/worker/tsconfig.json
npm test
```

- Node 22.18 or newer. TypeScript files are run directly; there is no build step. Use only syntax that can be
  stripped (no enums, no parameter properties).
- Keep it small. This is not a framework. If a change needs a page of explanation, it probably belongs in a fork.
- Every claim in the docs is either something that was run, with the result, or has a source. Mark anything else
  "not run".
- Plain language, short sentences, no hype.
- Never commit a secret, an account id or a `workers.dev` URL.

Pull requests: describe what you ran and paste the output of `verify.mjs` for at least one render.

By contributing you agree that your contribution is under the MIT licence of this repository.
