---
id: cli
title: CLI
crumb: 'Cloudflare Containers'
---

# remotion-cloudflare

The command line of the package. Subcommands follow
[`npx remotion lambda`](https://www.remotion.dev/docs/lambda/cli). It cannot be `npx remotion cloudflare`: the
Remotion CLI only knows the packages it ships with.

```bash
node packages/cloudflare-containers/bin/remotion-cloudflare.mjs <command>
```

## sites create

```bash
remotion-cloudflare sites create src/index.ts --site-name=site
```

Bundles the project into `build/sites/<site-name>`. See [deploySite()](deploysite.md).

### `--site-name`

Default `site`.

### `--sites-dir`

Default `build/sites`.

## services deploy

```bash
remotion-cloudflare services deploy
```

Runs `wrangler deploy` in the current folder. See [deployService()](deployservice.md).

### `--cwd`

Another service folder.

## services info

Prints what [getServiceInfo()](getserviceinfo.md) returns.

## render

```bash
remotion-cloudflare render Shapes --props='{"title":"Hello","durationInSeconds":60}' --concurrency=4 --out=out/video.mp4
```

Starts a render, prints progress lines to stderr, downloads the result, deletes the render and prints a JSON summary
to stdout.

### `--serve-url`

A site name or an https URL.

### `--props`

JSON, or the path of a JSON file.

### `--concurrency`

Instances. Default 1. Alias: `--instances`.

### `--processes-per-instance`, `--frames-per-chunk`, `--max-retries`, `--concurrency-per-process`

As in [renderMediaOnCloudflare()](rendermediaoncloudflare.md).

### `--frames`

`0-299`.

### `--codec`, `--scale`, `--jpeg-quality`, `--crf`, `--video-bitrate`, `--x264-preset`, `--image-format`, `--muted`, `--timeout`

### `--webgl`

The composition uses WebGL.

### `--gl`

Force a GL backend: `swangle`, `angle-egl`, `angle`, ...

### `--out`

Default `out/<composition>.mp4`.

### `--keep`

Do not delete the render afterwards.

### `--quiet`

No progress lines.

### `--service-url`

Default: `REMOTION_CLOUDFLARE_SERVICE_URL`. The secret is read from `REMOTION_CLOUDFLARE_SECRET` only, never from a
flag, so it does not end up in your shell history.

### `--local`

Render on this machine with the same coordinator, without Cloudflare. With `--sites-dir`, `--project-dir`,
`--engine`.

### `--docker=<image>`

Render in local Docker containers of that image. `--docker-args` adds arguments to `docker run`.

## still

```bash
remotion-cloudflare still WebFont --frame=100 --out=out/still.png
```

## progress

```bash
remotion-cloudflare progress <render-id>
```

## rm

```bash
remotion-cloudflare rm <render-id>
```

## doctor

Checks the Node version, the Docker daemon, the wrangler login and, when configured, the service. The nearest
counterpart of `npx remotion lambda policies validate` and `npx remotion cloudrun permissions`.

## Not available

`functions`/`services ls`, `rm`, `rmall`; `sites ls`, `rm`, `rmall`; `compositions`; `quotas`; `regions`.
