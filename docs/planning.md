# Planning a fleet: tiers, cost classes, warm instances, sharing

This repository's service takes `instances` and `framesPerChunk` from the caller. That is right for rendering your own
videos: you know them. A service that renders many different videos needs to pick those numbers itself, and needs
rules for instances that many jobs share. This page is what the prototype of this design arrived at, measured on
Cloudflare `standard-4` on 2026-11-27 and 28.

In this repository: `packages/core/src/planner.ts` implements the tier and fleet arithmetic as pure functions with a
unit test. Everything else on this page is a pattern, **not built here**.

## A tier is a finish time, not an instance count

"Fast" should mean "ready sooner", whatever the video is. So a tier is two things:

| Tier | Target finish time | Chunk length |
| --- | --- | --- |
| `saver` | 25 % of the video's length, at least 5 minutes | 20 to 60 s |
| `economy` | 12 %, at least 3 minutes | 10 to 30 s |
| `standard` | 6 %, at least 2 minutes | 6 to 10 s |
| `fast` | 4 %, at least 90 s | 4 s |

The fleet follows from the content:

1. **Chunk length**, equal for the whole job (the join needs that), in whole seconds. Long enough that start-up is at
   most 15 % of a light chunk's time. Short enough that one chunk of the slowest kind still fits the target. When the
   two disagree the second wins, and the plan reports the start-up share.
2. **Processes**: per cost class (below), enough to finish that class's chunks inside the target. Never more
   processes than chunks.
3. **Instances**: processes divided by how many of that class share an instance.
4. Only then the caller's limit (`maxInstances`). A bounded plan says so (`bounded: true`), and it will be late.

```ts
import { planFleet, TIERS, toFleetOptions } from './packages/core/src/planner.ts';

const plan = planFleet({ fps: 30, frames: 108_000, segments: [{ startFrame: 30_000, endFrame: 36_000, cls: 'heavy' }] }, TIERS.standard, myRates, { maxInstances: 64 });
// { targetSeconds: 216, framesPerChunk: ..., chunks: { light, gl, heavy }, wantedInstances, instances, bounded, startupShare }
await startRender(service, { render, fleet: toFleetOptions(plan) });
```

What the prototype measured for one one-hour 1080p30 job with 404 s of heavy shader effects in it (M = measured,
E = estimated from sample renders; time is request to download URL with warm instances, a cold fleet added 25 to
113 s):

| Tier | Chunks | Fleet | Time to file | vCPU-seconds | Cost at list price |
| --- | --- | --- | --- | --- | --- |
| `saver` | 180 x 20 s | 31 | 985 s E | 52,300 E | $1.75 E |
| `economy` | 360 x 10 s | 59 | 519 s E | 50,700 E | $1.70 E |
| `standard` | 600 x 6 s | 108 | **335.6 s M** | **56,882 M** | **$1.75 M** |
| `fast` | 900 x 4 s | 151 | 221.5 s M (chunks not through R2) | about 58,800 M | about $1.87 M |
| 2 s chunks | 1800 x 2 s | 292 | **340.2 s M** | **66,742 M** | **$2.16 M** |

Readings:

- **Cost is nearly flat across tiers.** What a larger fleet buys is time. The CPU is about the same; start-up per
  chunk is what grows (14 % of chunk time at 6 s, 32 % at 2 s).
- **2 s chunks were not faster end to end**, and cost 23 % more CPU. The join had to fetch 3,600 small objects. That
  tier was dropped; see [long-videos.md](long-videos.md) for what would move that point.
- **The estimates were fitted on these same runs.** They are not validated on other content. Settle a price on the
  measured cost after the render, with an estimate shown before as a ceiling.

## Cost classes: what a frame costs, not what it shows

One number for "frames per second" is wrong by a factor of ten across content. Three classes were enough:

| Class | What | On one `standard-4` | GL backend |
| --- | --- | --- | --- |
| `light` | no WebGL: text, images, video, CSS | several processes share the instance: 5.8 fps per process, 5.1 s to the first frame | none (CPU raster) |
| `gl` | WebGL that is cheap in software | shares an instance: 3.9 fps (one data point) | `angle-egl` |
| `heavy` | WebGL that fills an instance on its own: a heavy shader, a 3D model | one chunk per instance: 1.46 fps median, 0.77 worst, 9.8 s to the first frame | `angle-egl` |

Those rates are `EXAMPLE_RATES` in the planner. They come from one project. Measure yours: render a few seconds of
each kind of content and read the frame rate from the progress.

Rules that came with the classes:

- A chunk has the heaviest class of anything visible in its frame range.
- **A heavy chunk gets an instance to itself.** A 49 s clip with a glow shader rendered at 0.42 fps on a whole
  instance without a GL flag and at 0.64 fps with `angle-egl`. In the prototype's first one-hour run the chunks that
  held it shared their instance with other chunks: that group took 1,103 s while the fastest group took 98.8 s, and
  the job took 44 minutes. With heavy chunks alone on their instances and 4 s chunks, the same job took 3.7 minutes
  for about 1.3 times the render cost.
- The deadline is per class: 4 times the median chunk time of that class so far, at least 60 s. One deadline for all
  chunks either kills heavy chunks or lets light ones hang for minutes.
- An estimate before the render: render 1 to 2 s samples, a few spread over the timeline and one in the middle of
  every heavy range. For the one-hour job that was 19 samples in 36 to 43 s for 3 to 4 cents.

The coordinator of this repository has one class: every chunk runs with `processesPerInstance` processes per instance.
For WebGL content use `processesPerInstance: 2` ([concurrency.md](concurrency.md)); for content that fills an instance
alone use `1`.

## Warm instances

A cold fleet is the largest single wait. Providing 109 instances took 113.4 s in one run: half were ready after
1.9 s, 90 % after 98.7 s. With the image already at most locations the same fleet was ready in 25.0 s. The slow
starts we could explain were image pulls at a location that had not run the image before.

What to do about it, in order of cost:

1. **Start on instances as they arrive.** This repository does that: the queue feeds whoever answers
   ([failures.md](failures.md)). Half the fleet working after 2 seconds is worth more than the whole fleet after 100.
2. **Warm during the upload.** The client knows roughly what it will render before the bytes are there. Start the
   instances when the upload starts; start-up then overlaps a wait that exists anyway. Reserve them for that job for
   a few minutes, then let anybody have them.
3. **A small warm pool.** Keep a few instances alive between jobs, not a fleet. The prototype's default: at most 2,
   each for at most 4 minutes after its last job. A warm `standard-4` costs $0.113 per hour while idle.
4. **Do not pre-warm a whole fleet per job.** It was measured: 109 instances cost $0.39 to warm and 293 cost $1.02,
   against $1.75 and $2.16 for the renders themselves. Pre-warming 16 to 24 instances cost under half a cent and
   saved the 49 to 57 s that a new image needed at new locations; it saved nothing when the image was already there.

There is no setting for any of this in Cloudflare Containers: an instance lives while something talks to it
([cold-starts.md](cold-starts.md)). A pool is your own Durable Object that starts, lends and stops instances.

## Many jobs on one pool: fair sharing

Without a shared limit the first long job takes every instance and a 20 s clip waits behind an hour of video. The
prototype's pool, one object for all jobs:

- **A cap** on instances that exist at all (starting, lent, being reset or warm), whoever asked.
- **Round robin.** Slots are granted one at a time, in turn, to the jobs that still want one.
- **A share limit.** No job holds more than 75 % of the cap while another job waits.
- **Give back.** A job above an equal split is asked for slots back. It stops giving work to its least loaded
  instances and returns each one when its current chunks end. A job always keeps one instance.
- **A reaper.** A job that was not heard from for 2 minutes loses its instances. A start that takes longer than 10
  minutes is destroyed. Nothing bills after the work stopped.

Measured: three short jobs arriving while a one-hour job held 24 of 32 instances took 43 to 66 s, about what they
take alone (34 to 46 s with a warmer image).
With a cap of 8, short jobs waited 25 to 29 s for a slot and the long job slowed from 63 s to 193 s. No chunk
crossed jobs; every output was checked against its own source.

## Leases and reset between jobs

A warm instance that goes from one job to the next carries what the last job left: files, a browser profile, cached
media. Between two users that is a leak. The prototype's rules:

- An instance belongs to **one job at a time** (a lease). Its task server refuses a task for any other job id.
- Before anybody else gets it, it is **reset**: every process killed, the work directory and caches deleted, the
  lease cleared. (`DELETE /jobs/<id>` of this repository's task server kills one job's processes and deletes its
  files; it has no lease and does not clear caches.)
- A reset that fails or takes longer than a minute **destroys** the instance. So does any doubt: an instance whose
  chunk hung is never lent again.
- CPU and instance time are counted per lease, so a reused instance bills each job for its own period.

This repository avoids the question: an instance's name starts with the render id, it is never shared between
renders, and it is destroyed when the render ends ([concurrency.md](concurrency.md)). That is the safe default. A
pool is worth its rules only when cold starts are what your users wait for.

## Output size changes the rates

A plan made from 1080p rates is wrong for a 480p preview or a 4K final, and not by the pixel ratio. Measured on
`standard-4`: footage and motion graphics run 1.28x faster at 480p and 0.43x as fast at 4K; heavy WebGL effects
1.14x and 0.73x. `packages/core/src/resolution.ts` has the table and `ratesForOutput()` to move planner rates; details
and a measured 1:44:00 project at 480p, 720p and 1080p in [resolution.md](resolution.md).

## How good an estimate gets

The prototype estimated time and cost before rendering from a few sample renders of the project itself (12 samples of
1-2 s, about 2 minutes and 3 cents). Against the real renders it did not see:

- long jobs (1:44:00, four tiers, 480p and 720p): time within -6 % to +39 %, cost within -4 % to +18 %;
- short jobs (20 s fixtures): time within -26 % to +64 %, because start-up dominates them;
- an 11-minute 4K range: cost -6 %, time -37 % (4K chunks and the join of 35 Mbit/s output are slower than the
  per-frame model says).

Show it as "about", charge what was measured, and cap the charge at the estimate plus a stated margin.
