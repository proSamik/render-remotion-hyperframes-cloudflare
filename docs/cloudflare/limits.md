---
id: limits
title: Limits
crumb: 'Cloudflare Containers'
---

# Limits

Cloudflare's numbers were read from its docs on 2026-11-27
(https://developers.cloudflare.com/containers/platform/limits/). They change; check there.

## Platform

| | |
| --- | --- |
| Largest instance | `standard-4`: 4 vCPU, 12 GiB memory, 20 GB disk. Custom types go no higher. |
| GPU | none |
| Architecture | `linux/amd64` |
| Concurrent use per account (defaults, can be raised) | 15,000 vCPU, 60 TiB memory, 300 TB disk |
| Image size | at most the instance's disk |
| Image storage | 50 GB per account |
| Runtime of an instance | no fixed maximum; hosts restart "on an irregular cadence" |
| Disk | ephemeral |
| Region | chosen by Cloudflare |
| Plan | Workers Paid |
| Request body through a Worker or Durable Object | 100 MiB by default |
| Durable Object alarm | 15 minutes per invocation (the coordinator uses one short alarm per round) |

## This package

| | |
| --- | --- |
| Instances per render | `MAX_INSTANCES_PER_RENDER`, 4 in the example. Yours to raise. |
| Chunked codecs | H.264 only. Other codecs render on one instance. |
| Video length | With the default join, bound by the disk of the instance that joins: chunks plus output must fit beside the image. The prototype of this design measured 11.46 GB used of 19.2 GB for one hour of 1080p and drew the line at about 85 minutes. `stitch: 'stream'` needs room for the output only, `'stream-fmp4'` for neither ([Long videos](../long-videos.md)). Not tested beyond 90 seconds in this repository. |
| One chunk without R2 | under 100 MiB, because it passes through the coordinator as a request body |
| Renders at once | not limited and not queued by the service |
| Input props | JSON in the request body; the job state including the props must fit in a Durable Object value (2 MB) |
| Chunks per render | The job state is one stored value and grows with the chunk count. Thousands of chunks approach 2 MB; we did not measure where it breaks |
| Output lifetime without R2 | until the instance stops: delete or download within 15 minutes of the render |
| Webhooks | none |
| Regions | not selectable |

## Compared with Lambda

Lambda: at most 15 minutes per function, 10 GB of disk and memory, 1,000 concurrent functions per region by default,
up to 200 functions per render (https://www.remotion.dev/docs/lambda/limits). There the chunk count is high and each
chunk is short. Here an instance has no time limit, so a long video also renders on few instances, slowly.
