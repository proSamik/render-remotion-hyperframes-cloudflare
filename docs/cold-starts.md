# Cold starts and warm instances

## What we measured

On Cloudflare `standard-4`, November 2026.

With this repository's Remotion image (334 MB compressed), from "render requested" to "file ready":

| Render | Instances | Wall time | Of which before the first frame |
| --- | --- | --- | --- |
| 10 s, 300 frames | 1, started cold | 30 s | about 6 s (instance start, plan, browser start) |
| 60 s, 1800 frames | 4, three started cold | 32 s | about 8 s |
| 1 still | 1, warm | 6 s | |

With an earlier, larger image (611 MB compressed), over 42 cold starts: 35 took 0.4 to 8 s (median 2.4 s). 7 took
24 to 116 s. In each slow one the virtual machine had just booted at a location that had not run the image before,
so the image was pulled first. A warm instance answered in 0.3 s.

Cloudflare's own wording: "Container cold starts can often be in the 1-3 second range, but this is dependent on image
size and code execution time" (https://developers.cloudflare.com/containers/). After the first deploy, wait a few
minutes before you expect container requests to succeed.

## What follows

1. Keep the image small. The pull time is the slow case.
2. Do not wait for one slow instance. The coordinator hands a chunk to whichever instance answers. An instance that
   is still starting gets no work, and an instance that never starts within 15 minutes is replaced. There is a unit
   test: with one instance that needs 10 minutes to start, the job still ends in under a minute on the other.
3. An idle instance costs money until it stops. Memory and disk are billed for as long as the instance runs:
   $0.0000314 per second for `standard-4`. The coordinator stops every instance it no longer needs as soon as the
   chunks are in one place, and the last one when you delete the render. If you never delete it, the instance stops
   after `INACTIVITY_TIMEOUT_SECONDS` (180 in the examples) without requests, and the coordinator stops it itself 15
   minutes after the render finished.

## Deploys

With the `durable_object` scheduling policy that the examples use, the Cloudflare docs say: "Deploying an updated
image map does not restart running Containers". A running render keeps its old image; the next instance that starts
gets the new one. With the older `default` policy a deploy rolls through running instances (`SIGTERM`, then `SIGKILL`
after 15 minutes); we lost running jobs that way in the earlier measurement. Either way the coordinator treats a
vanished task as a chunk to render again.

Hosts are also restarted by Cloudflare "on an irregular cadence". Same handling.

## Keeping instances warm

There is no setting for it. An instance stays up while something talks to it. If you render all day and want no cold
starts, raise `INACTIVITY_TIMEOUT_SECONDS` (maximum 6 hours) and accept the idle cost: one idle `standard-4` is
$0.113 per hour. We did not build a warm pool.

What the prototype of this design learned about warming (a small pool, warming during the upload, never a whole
fleet per job) is in [planning.md](planning.md#warm-instances).
