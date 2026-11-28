# Costs, and how to measure your own

## How Cloudflare bills a container

Prices from https://developers.cloudflare.com/containers/platform/pricing/ (read 2026-11-27, Workers Paid plan):

| Meter | Price | Billed on |
| --- | --- | --- |
| CPU | $0.000020 per vCPU-second | **active use** |
| Memory | $0.0000025 per GiB-second | what the instance type provisions, while the instance runs |
| Disk | $0.00000007 per GB-second | what the instance type provisions, while the instance runs |

For `standard-4` (4 vCPU, 12 GiB, 20 GB): $0.0000314 per second for memory and disk, plus up to $0.00008 per second
of CPU. Included per month: 375 vCPU-minutes, 25 GiB-hours, 200 GB-hours of disk. Egress: $0.025 per GB in North
America and Europe after 1 TB included; more elsewhere. Workers and Durable Object requests are billed separately and
are fractions of a cent per render. Workers Paid has a $5 monthly minimum.

So a render costs `cpuSeconds x 0.00002 + instanceSeconds x 0.0000314`, plus container egress of about 2 x the output
size once the monthly allowance is used ([below](#container-egress)). `estimatePrice()` computes exactly that.

## Instance types and cost

From https://developers.cloudflare.com/containers/platform/limits/ and /containers/pricing/, read November 2026.

| Type | vCPU | Memory | Disk |
| --- | --- | --- | --- |
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | 1/2 | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

- **Custom sizes**: with the Durable Object scheduling policy used here, `ctx.container.start({ vcpu, memoryMib,
  diskMb, ... })` instead of a named `instance`. Minimum 1/16 vCPU (`0.0625`), 256 MiB, 2 GB (`2000` MB); the maximum
  per instance is your account limit, by default 4 vCPU, 12 GiB and 20 GB, which Cloudflare can raise on request.
  This repository passes the named type from `INSTANCE_TYPE` (`standard-4`: rendering wants every core).
- **Billing**, in 10 ms steps while an instance runs: CPU on **active use** ($0.000020 per vCPU-second), memory
  ($0.0000025 per GiB-second) and disk ($0.00000007 per GB-second) on the **provisioned** size, busy or idle.
  Workers Paid includes 375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours of disk per month. Egress:
  $0.025 per GB in North America and Europe after 1 TB per month, $0.04 elsewhere and $0.05 in Oceania, Korea and
  Taiwan after 500 GB (next section).
- So a `standard-4` costs $0.0000314 per second for memory and disk whether it renders or waits, plus up to
  $0.00008 per second of CPU when all 4 vCPU are busy.

## Container egress

Cloudflare bills bytes that containers send out ("Egress from Containers": $0.025 per GB in North America and
Europe after 1 TB included per month, $0.04 elsewhere after 500 GB, $0.05 in Oceania, Korea and Taiwan after 500 GB;
https://developers.cloudflare.com/containers/pricing/). The pricing, FAQ and outbound-traffic pages do not say what
counts as egress, so we measured it (2026-11-28, private implementation of this design, `standard-4`).

A render's containers send every chunk to storage and the joining instance sends the final file: about **2 x the
output size** per render (chunks were 1.03 x the output). For a 1:44:00 video at 10 Mbit/s that is about 16 GB.
Downloads by your users from R2 are free, and so is anything a container receives.

**Routing uploads through the Worker does not avoid it.** We ran the same 20 s renders with the containers uploading
(a) over presigned URLs to the public R2 endpoint and (b) to a hostname that the Durable Object intercepts with
`ctx.container.interceptOutboundHttp()`, handled by a `WorkerEntrypoint` that writes through the R2 binding. Both
outputs were byte-identical. Cloudflare's GraphQL Analytics dataset `containersUsageAdaptiveGroups` (field
`sum.txBytes`; its daily totals matched the dashboard's egress figure exactly) counted path (b) exactly like path (a):

| Path | Bytes the containers sent | Billed `txBytes` in that window |
| --- | --- | --- |
| (b) outbound handler + R2 binding, two renders at once | 2 x 52,649,639 | 106.2 MB |
| (a) presigned URL to the public R2 endpoint | 52,649,639 | 53.0 MB |

So treat **every byte a container sends** as egress, whatever the destination. Options that do reduce it: a lower
bitrate, fewer hedged or repeated chunks, and joining on the instance that rendered most of the chunks (its own
chunks never leave it). The outbound-handler path is still useful for other reasons (no storage keys in the
container); this guide's gateway mode uses it.

How to read your own: query `containersUsageAdaptiveGroups { sum { txBytes } dimensions { datetimeMinute } }` for your
account in the GraphQL Analytics API (https://developers.cloudflare.com/analytics/graphql-api/) around one render,
with nothing else running. The broader `containersMetricsAdaptiveGroups.txBytes` counts several times more than
the bill does (traffic to the Durable Object included); use the usage dataset.

## Idle warm instances

Memory and disk are billed while an instance runs, idle or not (CPU only when used). A pool that keeps instances warm
after a render for the next one bills $0.0000314 per second per `standard-4` while it waits. In the private
implementation (up to 4 instances kept warm for 240 s after each render) Cloudflare billed 266,678 instance-seconds
of memory on one day against 190,800 that the renders themselves recorded: **28 % of the memory bill was idle time**,
and memory was 47.6 % of CPU + memory on the bill against about 40 % in the per-render numbers. Warm instances were
reused for about 29 % of the instance starts, but a start with the image already at the location took 2.6 to 3.6 s, so
waiting warm instances saved seconds, not minutes. Keep the warm pool small and short (one or two instances, a
couple of minutes), and charge it to the render that left it behind when you price renders.

## What we measured

Everything below: Cloudflare `standard-4`, November 2026, Remotion 4.0.530, 1920x1080 at 30 fps, list prices, without
the included amounts. **Your numbers will differ.** Content decides almost everything.

### This repository's examples (2026-11-27 and 28)

Remotion's own Chrome Headless Shell, JPEG quality 90, x264 `veryfast`, 3 processes x 1 tab. Cold starts and the
join are inside these numbers.

| Render | Instances x processes | Wall time | vCPU-s | Instance-s | Cost |
| --- | --- | --- | --- | --- | --- |
| `Shapes` (text and shapes, sound), 10 s | 1 x 3, started cold | 30.3 s | 33.0 | 30.3 | $0.0016 |
| `Shapes`, 20 s | 1 x 3 | 31.8 s | 58.3 | 31.8 | $0.0022 |
| `Shapes`, 30 s, chunks through R2 | 2 x 3 | 31.2 s | 92.5 | 52.7 | $0.0035 |
| `Shapes`, 60 s | 4 x 3 | 32.4 s | 186.3 | 102.6 | $0.0069 |
| `WebFont`, 5 s | 1 x 3 | 15.3 s | 18.9 | 15.3 | $0.0009 |
| `Cube` (three.js on SwiftShader), 20 s | 1 x 2 | 53.0 s | 145.0 | 53.0 | $0.0046 |
| One still image | 1 | 6.2 s | 3.2 | 6.1 | $0.0003 |
| HyperFrames example, 8 s, quality `looks` | 1 | 17.2 s | 27.8 | 17.1 | $0.0011 |
| Mixed example, 8 s, layer already in the image | 2 x 3 | 35.3 s | 58.6 | 47.8 | $0.0027 |
| Mixed example, 8 s, layer rendered at job time | 2 x 3 | 37.4 s | 115.0 | 65.1 | $0.0043 |

So the light `Shapes` composition costs about $0.007 per output minute and needs about 3 vCPU-seconds per second of
video. These compositions are small on purpose. Real content costs more: see the next table.

Everything we ran on Cloudflare for this guide, about 30 renders, comes to roughly $0.12 at list price by these
counters, idle time not included.

### Heavier content (the earlier measurement)

Measured earlier on the same platform with a private prototype of this design and real compositions (see the
README). Render only: no cold start, no idle time.

| Content | vCPU-s per output second | Instance-s per output second | $ per output minute |
| --- | --- | --- | --- |
| Camera footage with captions and text | 6.06 | 1.80 | 0.0107 |
| Same, 10-minute timeline on 8 instances | 4.06 to 4.86 | 1.36 to 1.57 | 0.0074 to 0.0088 |
| Motion graphics (4 animated templates) | 11.24 | 3.28 | 0.0197 |
| HyperFrames layers composited by Remotion, layers cached | 5.29 | 1.61 | 0.0094 |
| Same, layers rendered cold | 12.55 | 3.92 | 0.0225 |
| A 3D device model (WebGL) on Mesa llvmpipe | 25.52 | 6.88 | 0.0436 |
| The same on SwiftShader | 74.86 | 19.79 | 0.1271 |

These are in `MEASURED_PER_OUTPUT_SECOND` in `packages/cloudflare-containers/src/api/estimate-price.ts`.

Method: CPU seconds are the whole virtual machine's busy time read from `/proc/stat` (user, nice, system, irq,
softirq, steal) between the start and the end of the work. The machine runs nothing else, so this should be what
Cloudflare bills as active CPU. **We did not compare it with the bill.** Instance seconds are wall time.

The counter belongs to the instance, not to a task. A task that reads it sees the CPU of everything that ran on the
instance meanwhile, so two tasks that share an instance each include the other's. The coordinator therefore adds up
one number per instance (the increases of the instance's own counter), never the tasks' figures. One job's summary in
the prototype said 86,042 vCPU-seconds before that correction and 58,800 after.

### What is not in any of these numbers

- Idle time before an instance stops: $0.0000314 per second. 90 seconds idle costs as much as rendering 15 seconds of
  footage.
- A slow cold start (up to 116 s seen): memory and disk are billed while the image is pulled.
- Hosts differ. The same chunk took 93 to 191 s on eight instances of one run.
- Container egress (above): about 2 x the output size per render, billed beyond the monthly allowance.
- Warm instances waiting for the next render (above), R2 storage, the Remotion licence (see the README).

Short renders therefore cost more per minute than long ones.

## Measure your own

1. Deploy your composition (any example folder).
2. Render something representative, at least 30 seconds, twice. The second run is warm.
3. Read `costs` from the result:

   ```bash
   node packages/cloudflare-containers/bin/remotion-cloudflare.mjs render MyComp --concurrency=2 --out=out/test.mp4
   # "costs": { "accruedSoFar": 0.006949, "cpuSeconds": 186.3, "instanceSeconds": 102.6, ... }
   ```

   `cpuSeconds` comes from inside the instances. `instanceSeconds` is each instance's lifetime as the coordinator saw
   it, from its first request to the moment it was stopped.
4. Divide by the seconds of video. Multiply by your monthly minutes.
5. Check against the real bill after a few days (dashboard, Billing, or Containers metrics). Tell us if the two
   disagree.

Things that move the number, in order of effect in our measurements:

1. The GL backend for WebGL content: up to 2.8x. See [gl-backends.md](gl-backends.md).
2. `swangle` on content that has no WebGL: 1.7 to 5.5x more than Remotion's default.
3. Whether pre-rendered layers are cached: 2.4x. See [mixed.md](mixed.md).
4. Filling the instance: 3 processes instead of 1 is about 10 % cheaper and 1.7x faster.
5. `x264Preset`. Remotion's default is `medium`; the numbers above used `veryfast`.
6. CSS that is slow without a GPU: large blurs, shadows, gradients, filters (https://www.remotion.dev/docs/performance).
