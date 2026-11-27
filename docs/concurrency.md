# Concurrency: tabs, processes, instances, many jobs

There are four levels. They do not help equally.

## 1. Browser tabs in one render process (Remotion `concurrency`)

They barely help without a GPU. Measured on `standard-4` (4 vCPU), footage with captions, 1080p30, earlier
measurement:

| Tabs | fps | vCPU-seconds per output second |
| --- | --- | --- |
| 1 | 9.9 | 5.13 |
| 2 | 10.1 | 6.22 |
| 4 | 10.6 | 7.97 |

One render process uses 1.5 to 2.8 of the 4 vCPUs whatever the tab count. More tabs cost CPU and buy almost no
speed. Remotion says the same about Lambda: "We recommend using more Lambdas instead of more concurrency per Lambda".

## 2. Render processes in one instance

They do help.

| Processes x tabs | fps | vCPU-seconds per output second | $ per output minute |
| --- | --- | --- | --- |
| 1 x 1 | 9.9 | 5.13 | 0.0119 |
| 2 x 1 | 13.5 | 5.94 | 0.0113 |
| 3 x 1 | 16.6 | 6.06 | 0.0107 |
| 4 x 1 | 16.5 | 6.78 | 0.0116 |

Because memory and disk are billed for wall time, finishing sooner is cheaper even at slightly more CPU.

So the default here is **3 processes per instance, 1 tab each** (`processesPerInstance`, default 3). A chunk is the
unit of work of one process.

WebGL content fills the instance with fewer: 2 processes gave 4.25 fps, 4 processes 4.30 fps. Use
`processesPerInstance: 2` for WebGL.

## 3. Instances for one render

`concurrency` in `renderMediaOnCloudflare()` (the HTTP field is `fleet.instances`). Each instance runs
`processesPerInstance` chunks at a time.

Measured with this repository's example (light motion graphics, 1080p30):

| Video | Instances | Chunks | Wall time, cold start included |
| --- | --- | --- | --- |
| 10 s | 1 | 3 | 30 s |
| 60 s | 4 | 12 | 32 s |

Earlier, footage with captions, 10 minutes: 8 instances x 3 processes, 24 chunks, 193 to 241 s. That is 3.1 times
real time.

The service refuses more instances per render than `MAX_INSTANCES_PER_RENDER` (4 in the examples). That number is
your spend limit per render. Raise it in `wrangler.jsonc`.

## 4. Many renders at once

Every render is its own Durable Object with its own instances. Instance names start with the render id, so two
renders never share an instance, a file or a retry counter.

What they do share is your account's capacity. The default account limit is 15,000 concurrent vCPUs (3,750
`standard-4` instances). With the `durable_object` scheduling policy there is no `max_instances` setting in
`wrangler.jsonc`: the only caps are your own `MAX_INSTANCES_PER_RENDER` and how many renders you start.
**This service does not queue renders and does not limit how many run at once.** Put your own limit in front of it
if anyone but you can start a render. An earlier prototype of ours used a fair queue over a fixed pool of instance
slots (round robin, no job above 75 % of the pool); it is not part of this repository.

When Cloudflare cannot start an instance, the request to it fails, the chunk stays queued and is tried again on the
next round. A render waits; it does not fail for lack of instances until 15 minutes have passed without any instance.

## Picking numbers

- Short clip (under 30 s): 1 instance. More instances mostly add cold starts.
- 1 to 5 minutes: 2 to 4 instances.
- Longer: as many as you allow yourself. Past about 10 s per chunk there is no reason to make chunks smaller.
- HyperFrames: 1 instance per video. See [chunking.md](chunking.md).
