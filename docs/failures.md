# Failures and retries

Four kinds of failure happened to us on real Cloudflare Containers. Each has a fix in
`packages/core/src/coordinator.ts` and a unit test in `packages/core/test/coordinator.test.ts` that reproduces it
against a simulated fleet.

| # | What happens | How it looks | The fix |
| --- | --- | --- | --- |
| 1 | An instance starts slowly (image pull at a new location: 24 to 116 s) | A short chunk would wait longer than it takes to render | Chunks are handed to whichever instance answers. Nobody waits for the slow one. An instance that does not answer within 15 minutes is replaced. |
| 2 | A chunk hangs | The task stays "running" and never ends. Seen once: 15 minutes | Per-chunk deadline: `max(300 s, frames / 1.5 fps)`, or `chunkDeadlineSeconds`. Past it the task is killed, the instance is destroyed and replaced, the chunk is queued again. |
| 3 | An instance restarts | Its tasks and files are gone; the task server answers but does not know the task | The chunk is queued again. Chunks that were rendered there and not yet copied elsewhere are rendered again too. |
| 4 | A file arrives damaged | Right length, wrong bytes, after travelling container to Worker to container. No error anywhere | SHA-256 on both sides. The sender's hash is compared with the receiver's receipt. The transfer is repeated up to 3 times, then the chunk is rendered again. The final download is checked the same way by the client. |

And one more that is not a failure but costs time:

| What happens | The fix |
| --- | --- |
| A straggler: one chunk lands on a slow host. Hosts differed by up to 2.4x in CPU for the same chunk. | When nothing is queued and a slot is free, a chunk that has run more than twice the median (and more than 30 s) is started a second time on another instance. The first result wins; the other copy is cancelled. Turn it off with `duplicateStragglers: false`. |

## Limits of the retries

- A chunk that fails more than `maxRetries` times (default 2) fails the render. The reason is in `errors` of the
  progress. A composition that throws on frame 512 will throw there three times; that is not something to retry
  forever.
- Stitching is tried 3 times.
- A job never adds more than `3 x instances + 2` instances in total.

## What the client sees

Every recovered problem is listed in `errors` with `fatal: false`, so you can see what happened:

```json
{ "at": 1795802765017, "chunk": 3, "instance": "r9f3-1", "message": "chunk 3 passed its deadline: instance replaced", "fatal": false }
```

`fatalErrorEncountered: true` means the render stopped.

## What was not hit in this repository's own runs

In the runs for this guide (about 30 renders on Cloudflare, up to 4 instances) no retry was needed. The four cases
above come from an earlier, larger measurement (93 jobs, up to 8 instances and more). The fixes are exercised by the
unit tests, not by a real failure in this code base. Read the tests before you trust them.

## Signals

The task server handles `SIGTERM`: it kills its render processes and exits. Cloudflare sends `SIGTERM` before it
stops an instance. The image starts with `dumb-init` so the signal reaches Node and finished browser processes are
reaped.
