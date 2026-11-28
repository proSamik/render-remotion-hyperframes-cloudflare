---
id: comparison
title: Comparison of server-side rendering options
crumb: 'Cloudflare Containers'
---

# Lambda, Cloud Run, Vercel Sandbox, Cloudflare Containers

Remotion's own comparison is at https://www.remotion.dev/docs/compare-ssr. It is written as prose under the headings
below and already lists Cloudflare Containers as an alternative, described as "a proof of concept which you adopt
and own. It's not a package like Lambda and not production-ready." This page uses the same headings and adds what
this package changes. Statements about the other three are Remotion's, read on 2026-11-27. Statements about
Cloudflare are ours.

## Overall recommendation

Remotion recommends Lambda for most people. We agree: it is the option Remotion builds, tests and supports.
This package is for people who want to stay on Cloudflare, or who want distributed rendering in an image they
control. It is an unofficial community package with a short test history.

## Speed

| | |
| --- | --- |
| Lambda | The fastest. A render is split over up to 200 functions. Remotion's example: a 10-minute HD video in about a minute. |
| Vercel Sandbox | One machine. No distributed rendering. |
| Cloud Run | One machine per render. No distributed rendering. |
| Cloudflare Containers (this package) | Distributed over as many instances as you allow, each running 3 render processes. Measured: 60 s of light 1080p30 motion graphics in 32 s on 4 instances, cold start included; earlier, 10 minutes of footage in 193 to 241 s on 8 instances. Not tested with large fleets in this repository. |

## Cost

| | |
| --- | --- |
| Lambda | Pay per invocation time and memory. Remotion's examples: $0.017 for a 1-minute video, $0.103 for 10 minutes. Storage, logs and data transfer come on top. |
| Vercel Sandbox | "based on usage. You only pay for the time the VM is running". Remotion states no figure. |
| Cloud Run | Described by Remotion as cheaper than Lambda. |
| Cloudflare Containers | CPU by active use plus memory and disk by instance time. Measured $0.007 to $0.044 per output minute depending on content ([Cost](cost.md)). R2 has no egress fee. |

## Ease of setup

| | |
| --- | --- |
| Lambda | An AWS account, IAM policies, a few CLI commands. Remotion provides the function. |
| Vercel Sandbox | The easiest according to Remotion, with a starter template. |
| Cloud Run | A GCP project and permissions. Remotion provides the image. |
| Cloudflare Containers | A Cloudflare account, `wrangler login`, Docker, one deploy. You own a Dockerfile and a wrangler file. Nothing is provided ready-made; the image is built from your project. |

## Render duration

| | |
| --- | --- |
| Lambda | 15 minutes per function; long videos work because they are split. |
| Vercel Sandbox | 45 minutes on Hobby, 5 hours on Pro and Enterprise. |
| Cloud Run | The request timeout of the service. |
| Cloudflare Containers | No fixed limit on an instance. The render is coordinated by a Durable Object, not by one HTTP request. |

## Feature set

| | Lambda | Vercel Sandbox | Cloud Run | Cloudflare Containers (this package) |
| --- | --- | --- | --- | --- |
| Maintained by Remotion | yes | yes, experimental | critical fixes only, alpha | no |
| Distributed rendering | yes | no | no | yes, H.264 only |
| Progress | yes | yes | yes | yes |
| Retries | yes | | | yes, plus chunk deadlines and a second run for measurably slow chunks |
| Stills | yes | yes | yes | yes |
| Webhooks | yes | no | yes (status webhook) | no |
| Cost estimation | yes | no | no | yes, from measured CPU time |
| Expiring renders | yes | | | R2 lifecycle rule, your own |
| Presigned URLs | yes | Vercel Blob URLs | yes | with R2 S3 keys; not run by us |
| Clients in other languages | PHP, Go, Python, Ruby | no | no | no; a plain HTTP API |
| Custom fonts in the runtime | via web fonts, or custom layers | web fonts | web fonts | the image is yours |
| Choice of GL backend | `swangle` by default | pass-through | `swangle` by default | per chunk; default is CPU raster |

## GPU

None of the four has a GPU in its standard form. On Cloudflare, software rendering for WebGL can be SwiftShader or
Mesa llvmpipe; for a heavy 3D scene llvmpipe was 2.4 times cheaper in our measurement, for a small one 1.3 times ([GL backends](../gl-backends.md)).

## Stability

Lambda has years of production use. Vercel Sandbox is new and marked experimental. Cloud Run is "not being actively
developed". This package was written in November 2026 and has been run a few dozen times. The platform API it
uses (`ctx.container` with the `durable_object` scheduling policy) is in public beta at Cloudflare.

## Sources

- https://www.remotion.dev/docs/compare-ssr
- https://www.remotion.dev/docs/lambda/limits, https://www.remotion.dev/docs/lambda/cost-example
- https://www.remotion.dev/docs/cloudrun/status
- https://www.remotion.dev/docs/vercel-sandbox
- https://www.remotion.dev/docs/cloudflare-containers
- https://developers.cloudflare.com/containers/
