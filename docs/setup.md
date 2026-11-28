# Setup from zero

Everything from "no Cloudflare account" to a rendered video, and back to nothing. It deploys the smallest example,
`examples/remotion-only`; the other examples and the one-click service ([deploy.md](deploy.md)) work the same way.

**Validated end to end on 2026-11-28** on a clean account state under a throw-away name: fresh clone, `npm run
setup`, bucket, deploy, secret, two renders (`npm run cloud` and curl), usage read back, teardown. Wrangler 4.169.0,
Docker on a second machine over SSH (see the end of this page). Not validated literally: creating the R2 S3 API
token (it is a dashboard step; the steps below are from the dashboard and Cloudflare's docs), and a Docker running
on the same machine as wrangler.

Durations are mm:ss. Commands run from the folder named above them. **Run wrangler commands one at a time**, not in
parallel and not in a loop that fires them together: two wrangler processes refreshing the same login at once can
leave you logged out, and two deploys of the same Worker race each other.

## 1. Account, plan and permissions

1. A Cloudflare account (https://dash.cloudflare.com/sign-up).
2. **Workers Paid** ($5 a month): dashboard, *Workers & Pages*, *Plans*. Containers are not available on the Free
   plan. The plan includes per month 375 vCPU-minutes, 25 GiB-hours of memory, 200 GB-hours of disk and 1 TB of
   container egress (North America and Europe); a few hundred small test renders fit inside that.
3. Containers need no separate switch on a paid account: the first `wrangler deploy` with a `containers` entry
   creates the container application. If your account shows a Containers page with a "get started" or beta notice,
   accept it there first.
4. Your user needs, on that account: **Workers Scripts: Edit** (Worker, Durable Objects, secrets), **Containers:
   Edit** (container application and image registry) and, for the bucket, **Workers R2 Storage: Edit**. An account
   Super Administrator has all of them. With an API token instead of `wrangler login`, give the token these three
   plus *Account Settings: Read*, and *Account Analytics: Read* if you want to read usage (section 10).

## 2. Tools on your machine

- Node.js 22.18 or newer (`node -v`). It runs the TypeScript of this repository directly.
- Git.
- Docker, to build the image: Docker Desktop, OrbStack, Colima or Docker Engine. `docker info` must answer. No Docker
  on this machine: see [Building the image elsewhere](#building-the-image-elsewhere).
- FFmpeg (`ffprobe`), only for the checks of section 7.

```bash
git clone https://github.com/proSamik/render-remotion-hyperframes-cloudflare
cd render-remotion-hyperframes-cloudflare
npm run setup                          # root + the three examples; this installs wrangler too
npx wrangler login                     # opens the browser; `npx wrangler whoami` checks it
```

`npx wrangler whoami` lists the account and the scopes of the login. If you have several accounts, set
`CLOUDFLARE_ACCOUNT_ID` in your shell (never in a file you commit).

Render locally once before you deploy anything. It proves the composition works and costs nothing:

```bash
cd examples/remotion-only
npm run local                          # out/local.mp4
```

## 3. Name your service

Every name below must be unique on your account. In `examples/remotion-only/wrangler.jsonc`:

```jsonc
"name": "my-render",                      // the Worker: https://my-render.<your-subdomain>.workers.dev
"vars": { "SERVICE_NAME": "my-render", ... }
```

The container application is named after the Worker and the class (`my-render-rendercontainer`); you do not
create it yourself.

## 4. R2 bucket (recommended)

Without a bucket the service works, but the output lives on one instance for at most 15 minutes. With one, chunks
and outputs are stored in R2 and downloads from R2 cost nothing.

```bash
npx wrangler r2 bucket create my-render
```

Then remove the `//` in front of the `r2_buckets` line of `wrangler.jsonc` and put your bucket's name in it:

```jsonc
"r2_buckets": [{ "binding": "RENDER_BUCKET", "bucket_name": "my-render" }]
```

That is all the default mode needs: the containers reach the bucket through the Worker and hold no keys
([r2.md](r2.md)). Wrangler asks whether it should add the binding for you when it creates the bucket; answer no
(it would pick its own binding name) and edit the file. The line ends without a comma and the line before it has
one, so removing `//` is the whole edit.

### R2 S3 API token (optional: presigned links and direct transfer)

Only needed for `?presign=` download links and for `R2_DIRECT` ([r2.md](r2.md)). Wrangler cannot create it; the
dashboard does:

1. Dashboard, *R2 Object Storage*, *Overview*, **Manage API tokens** (top right; also under *API* on the same page),
   **Create Account API token** (or *User API token*: it stops working when that user leaves the account).
2. Name: `my-render`. Permissions: **Object Read & Write**. **Specify bucket(s)**: only `my-render`. TTL: your choice
   (forever, or a date you will remember to renew).
3. Create. The page shows an **Access Key ID** and a **Secret Access Key** once. Copy both into two files outside the
   repository, or straight into the next commands. The *token value* shown above them is not needed here.

Give them to the Worker as secrets, and the account id and bucket name as variables:

```bash
printf %s "<access key id>"     | npx wrangler secret put R2_ACCESS_KEY_ID
printf %s "<secret access key>" | npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler deploy --var R2_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID --var R2_BUCKET_NAME:my-render
```

Mind the **trailing newline**. `wrangler secret put` drops one trailing newline from what you pipe in (we checked:
`openssl rand -hex 24 | npx wrangler secret put RENDER_SECRET` stores 48 characters), but your own code may not:
a client that reads the same value from a file with `readFileSync` sends 49 characters and gets `403`, and an S3
secret with a newline signs every URL wrong (`SignatureDoesNotMatch`). Write secret files with `printf %s`, and trim
when you read them. `--var` keeps the account id out of `wrangler.jsonc`; put the variables in the file
only if the file never leaves your machine.

## 5. Secrets and variables, all of them

| Name | Kind | Needed | What it is |
| --- | --- | --- | --- |
| `RENDER_SECRET` | secret | **yes** | The bearer token every request must carry. At least 16 characters. Without it the service answers `403` to everything |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | secrets | for presigned links, `R2_DIRECT` | the S3 API token of section 4 |
| `R2_ACCOUNT_ID` | var | with the two above | your account id: the S3 endpoint is `https://<id>.r2.cloudflarestorage.com` |
| `R2_BUCKET_NAME` | var | with the two above | the bucket the presigner signs for; the only one it can sign for |
| `R2_DIRECT` | var | no | `"true"`: containers move chunks and outputs over presigned URLs instead of through the Worker |
| `SERVICE_NAME` | var | no | shown by `/health` and in every logged event |
| `INSTANCE_TYPE` | var | no | `standard-4` (4 vCPU, 12 GiB, 20 GB disk), the largest. Smaller: `standard-1` ... `standard-3`. Rendering wants `standard-4` |
| `MAX_INSTANCES_PER_RENDER` | var | no | the largest `fleet.instances` a request may ask for: **your spend limit per render** |
| `INACTIVITY_TIMEOUT_SECONDS` | var | no | an instance nobody talks to stops after this long; it bills memory and disk until then |
| `ENABLE_INTERNET` | var | no | `"false"` cuts the containers off from the Internet (web fonts, remote media and `R2_DIRECT` stop working) |
| `CONTAINER_ENV` | var | no | JSON object of extra environment variables for the container, for example `{"RENDER_MULTIPART_ABOVE_MIB":"8"}` |
| `RENDER_BUCKET` | R2 binding | recommended | section 4 |

Secrets are set per Worker and survive deploys. `npx wrangler secret list` shows their names, never their values.

## 6. Build the image and deploy

```bash
cd examples/remotion-only
npm run deploy
```

This bundles the composition (`build/sites/site`), then runs `wrangler deploy`, which

1. builds `Dockerfile` with your local Docker (`linux/amd64`; build context: the repository root),
2. pushes it to your account's registry (`registry.cloudflare.com/<account id>/...`), logging Docker in with a
   short-lived password,
3. uploads the Worker and creates or updates the container application.

The first deploy is the slow one: the image is about 1.3 GB (Chrome, fonts, Mesa, Node). In our validation the
build machine sat on a phone connection: building took about 8 minutes and pushing about 15. On a normal line
expect a few minutes for each. Later deploys reuse the cached layers and push only what changed; a deploy whose
layers were all in the registry already took 5:30, most of it sending the build context over SSH.

Then the secret (wrangler asks before it creates the secret on a Worker that does not exist yet; deploy first):

```bash
openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put RENDER_SECRET
```

The value is printed once on your terminal. Keep it in a password manager.

Pitfalls of this step, all seen while writing this guide:

- **`exports`, not `migrations`.** The example declares its Durable Object classes under `exports` (the current way).
  A Worker cannot have both `exports` and `migrations`, and moving a class from `migrations` to `exports` is one way.
  `wrangler versions upload` and gradual deployments do not apply these changes: always `wrangler deploy`. To delete
  a class later: remove it from the code and from `durable_objects.bindings`, and give it
  `{ "type": "durable-object", "state": "deleted" }` in `exports`.
- **The scheduling policy cannot change** on an existing container application. A different `scheduling_policy`
  needs a new class (and so a new application); delete the old application with `wrangler containers delete`.
  Removing a `containers` entry from the config does not delete its application.
- **Every deploy restarts the Durable Objects**, and a deploy that changes the image restarts container instances. A
  render in flight survives (its state is in Durable Object storage, lost chunks are rendered again), but it gets
  slower. Do not deploy while something important renders.
- **Starts right after a deploy can hang.** For about the first minute after a deploy (and for longer the first time,
  while the image is copied to the locations), starting an instance may not answer. The coordinator waits and retries
  (`instance_start_failed` after 15 minutes), so a render started then is slow, not broken. Wait a minute after a
  deploy before you start a render you are timing.
- **The registry login expires.** Wrangler logs Docker in itself on every deploy. If you push by hand (below), the
  password is good for a limited time; log in again when a push answers `401`/`unauthorized`.
- **`wrangler containers list` can be stale.** Its "live instances" column lagged behind reality by minutes in our
  runs (it showed instances that had stopped, and 0 while one was starting). For what is billed, read the usage
  (section 10); for one instance, `npx wrangler containers instances <application id>`.

Building the image elsewhere: see the end of this page.

## 7. First render

```bash
export RENDER_SERVICE_URL=https://my-render.<your-subdomain>.workers.dev     # printed by the deploy
export RENDER_SECRET=<the secret>
curl -s "$RENDER_SERVICE_URL/health" -H "Authorization: Bearer $RENDER_SECRET"
# {"ok":true,"service":"my-render","storage":true,"instanceType":"standard-4","maxInstancesPerRender":4}

npm run cloud                                  # 10 s of the Shapes composition on 2 instances -> out/cloud.mp4
node ../../packages/core/scripts/verify.mjs out/cloud.mp4 --frames 300
```

In our validation (10 s of `Shapes`, 2 instances, R2 on, the image already at the location) `npm run cloud` took
0:42 from start to the checked file on disk; the render itself 0:32, estimated at $0.0024. A 5 s render on one
instance by hand with curl took 0:43: 0:13 in `planning` (instance start), 0:23 `rendering`, 0:05 `stitching`.

`npm run cloud` polls the progress, downloads the file, compares its SHA-256 and deletes the render. By hand:

```bash
curl -sX POST "$RENDER_SERVICE_URL/renders" -H "Authorization: Bearer $RENDER_SECRET" -H 'content-type: application/json' \
  -d '{"render":{"composition":"Shapes","inputProps":{"durationInSeconds":5}},"fleet":{"instances":1}}'
# {"renderId":"r0123456789ab"}
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "Authorization: Bearer $RENDER_SECRET"
# {"phase":"rendering","overallProgress":0.42,"chunks":{...},"instances":1,"costs":{"accruedSoFar":0.0007,...},...}
curl -s "$RENDER_SERVICE_URL/renders/r0123456789ab/output" -H "Authorization: Bearer $RENDER_SECRET" -o video.mp4
curl -sX DELETE "$RENDER_SERVICE_URL/renders/r0123456789ab" -H "Authorization: Bearer $RENDER_SECRET"
```

`phase` goes `planning` (an instance starts and reads the composition), `rendering`, `stitching`, `done`.
`overallProgress` never goes back. `errors` lists everything that went wrong, also what was recovered
(`fatal: false`). With R2 and the S3 token, `GET /renders/<id>/output?presign=3600` answers a link that works without
the secret for an hour. Fields: [progress.md](progress.md).

## 8. Logs and error events

- `npx wrangler tail` streams the Worker's and the Durable Objects' logs live (one command; stop it with Ctrl-C).
- Dashboard, *Workers & Pages*, your Worker, **Logs**: the same, stored (`observability.enabled` is on in the
  example). Every problem the coordinator sees is one JSON line with a fixed `kind` (`chunk_failed`,
  `instance_start_failed`, `job_failed`, ...): filter on it. Forwarding them to an error tracker:
  [failures.md](failures.md).
- Dashboard, *Workers & Pages*, *Containers*, your application: instances, their state and location, and the
  container's own stdout/stderr (the task server prints one line per start). Container logs are billed like Workers
  Logs.

## 9. Limits, and raising them

Defaults per account (https://developers.cloudflare.com/containers/platform/limits/): 15,000 vCPU, 60 TiB of memory
and 300 TB of disk running at once (3,750 `standard-4` instances); one instance at most 4 vCPU, 12 GiB, 20 GB disk;
an image at most as large as the instance's disk; **50 GB of images per account**; 100 MiB per request body that a
container sends through an outbound handler (the gateway: outputs above 90 MiB are uploaded in parts). "All instance
size maximums and account limits on this page are defaults and can be increased": ask your account team or
Cloudflare Support.

Your own limits are `MAX_INSTANCES_PER_RENDER` (per render) and whoever holds `RENDER_SECRET` (number of renders:
there is no queue and no rate limit).

## 10. What it costs, and how to watch it

List prices, Workers Paid, read 2026-11-28 (https://developers.cloudflare.com/containers/pricing/):

| What | Price after the monthly allowance | Allowance per month | Billed when |
| --- | --- | --- | --- |
| CPU | $0.000020 per vCPU-second | 375 vCPU-minutes | only what the instance uses |
| Memory | $0.0000025 per GiB-second | 25 GiB-hours | every second an instance runs, idle or busy (12 GiB on `standard-4`) |
| Disk | $0.00000007 per GB-second | 200 GB-hours | the same (20 GB on `standard-4`) |
| Container egress | $0.025 per GB (North America, Europe); $0.04, $0.05 elsewhere | 1 TB (500 GB elsewhere) | **every byte a container sends**, also to your own Worker and R2 |
| Workers, Durable Objects | Workers Paid rates | | requests and the coordinator's alarms; cents |
| R2 | $0.015 per GB-month, operations | 10 GB, 1 M writes, 10 M reads | downloads (egress) are free |

Two costs are easy to miss:

- **Idle instances bill memory and disk**: a `standard-4` that waits costs $0.0000314 per second ($0.11 per hour).
  The example stops an instance 180 s after its last request (`INACTIVITY_TIMEOUT_SECONDS`) and the coordinator stops
  every instance of a render when it is done.
- **Container egress includes traffic to the Worker.** A container that sends a chunk to the Worker's R2 gateway
  (an outbound handler) is billed for it exactly like an upload to the public R2 endpoint: we measured it
  ([costs.md](costs.md#container-egress)). A render sends about twice its output size (chunks, then the joined file).

**Reading the real numbers.** The dashboard's *Billing*, *Billable Usage* shows the month by product. Per minute and
per application, Cloudflare's GraphQL Analytics dataset `containersUsageAdaptiveGroups` has `cpuTimeSec`,
`allocatedMemory` and `allocatedDisk` (byte-seconds) and `txBytes` (egress); its daily totals match the bill. This
repository has a script for it (an API token with *Account Analytics: Read*):

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node packages/core/scripts/cf-usage.mjs \
  --since 2026-11-28T10:00:00Z --until 2026-11-28T10:30:00Z --app <ID from npx wrangler containers list>
```

Usage shows up a few minutes late (in our check, about 5 minutes after the render; a query made sooner answers 0). Every render also reports its own estimate in `costs` of the progress.

**Budget alerts.** Dashboard, *Manage Account*, *Billing*, *Billable Usage* (or *Notifications*, *Add*, **Budget
Alert**): an e-mail when the month's spend passes an amount you choose. It does not stop anything. The hard
*Spend Management* limits cover Workers and Durable Objects, not Containers (read 2026-11-28), so a budget alert is
the guard you have for container spend; `MAX_INSTANCES_PER_RENDER` and a secret you keep to yourself are the others.

## 11. Updating

- **Your composition changed**: `npm run deploy` again. The bundle is in the image, so every change is a new image.
- **The Worker only** (vars, coordinator code): `npx wrangler deploy` (it rebuilds the image too, from cache, and
  only pushes changed layers).
- **Dependencies**: change the versions in `package.json` (`remotion` and every `@remotion/*` on one version),
  `npm install`, `npm run local`, then deploy.
- After a deploy: wait about a minute, then one short render (section 7) before real work.

Old images stay in the registry and count against the 50 GB: `npx wrangler containers images list`, then
`npx wrangler containers images delete <repository>:<tag>` for the ones no deployed version uses.

## 12. Teardown

Everything the steps above created, in this order:

```bash
cd examples/remotion-only
# 1. delete every render you still have (DELETE /renders/<id>): that empties the bucket of chunks and outputs
npx wrangler containers list                         # note the ID of my-render-rendercontainer
npx wrangler delete                                  # the Worker, its secrets and its Durable Objects
npx wrangler containers delete <ID>                  # the container application: wrangler delete does NOT remove it
npx wrangler containers images list                  # one repository per application, one tag per deploy
npx wrangler containers images delete my-render-rendercontainer-render:<tag>    # each tag
npx wrangler r2 bucket delete my-render              # only an empty bucket can be deleted
```

`wrangler delete` says it itself: the container application "keeps running and billing now that the Worker is
gone" until you delete it. Wrangler has no command to list or empty a bucket: if `r2 bucket delete` refuses because
objects are left (renders you did not delete, uploads), empty it in the dashboard (*R2 Object Storage*, the bucket,
select all objects, *Delete*) or give it a lifecycle rule that deletes everything after one day, then delete it.
Docker on the build machine keeps the image and its layers: `docker image prune` there if you need the space, and
`docker logout registry.cloudflare.com` (wrangler logged Docker in to your registry).

Then the S3 API token, if you made one: dashboard, *R2 Object Storage*, *Manage API tokens*, the token, **Delete**.
Check that nothing is left: `npx wrangler containers list`, `npx wrangler containers images list`,
`npx wrangler r2 bucket list`.

## Building the image elsewhere

Wrangler builds with whatever `docker` answers. Three ways when Docker is not on this machine:

1. **Docker on another machine over SSH** (what we used to validate this page): any x86-64 Linux box with Docker that
   you can `ssh` to. Wrangler's `docker build` and `docker push` then run there; the build context is sent over SSH.

   ```bash
   DOCKER_HOST=ssh://user@buildbox npm run deploy
   ```

   The local `docker` command needs the **buildx** plugin (wrangler builds with `docker build --load`; without
   buildx the error is `unknown flag: --load`): `docker buildx version` must answer. Homebrew: `brew install
   docker-buildx`, then link it into `~/.docker/cli-plugins/`. Every build sends the build context (about 40 MB for
   this example, the bundles included) over SSH, and the push runs from the remote machine: on a slow or unstable
   link, push once from that machine (option 2) so wrangler only finds the layers already there.

2. **Build and push yourself, deploy a registry reference**: `npx wrangler containers build -p -t my-render:v1 ../..`
   on a machine with Docker, or `docker save` there and `crane push` here
   ([daemonless-deploy.md](daemonless-deploy.md)). Then point `images.render` at
   `registry.cloudflare.com/<account id>/my-render@sha256:<digest>` (pinned by digest) and `wrangler deploy` needs no
   Docker.
3. **Workers Builds** (Cloudflare builds from your Git repository, also the Dockerfile): the path of the Deploy
   button ([deploy.md](deploy.md)).
