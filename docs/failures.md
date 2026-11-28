# Failures and retries

Each row below happened on real Cloudflare Containers, in the private prototype this design comes from (93 jobs in a
first round, then one-hour jobs on 100 to 290 instances). Each has a fix in `packages/core/src/coordinator.ts` and a
unit test in `packages/core/test/coordinator.test.ts` that reproduces it against a simulated fleet.

| # | What happens | How it looks | The fix |
| --- | --- | --- | --- |
| 1 | An instance starts slowly (image pull at a new location: 24 to 116 s) | A short chunk would wait longer than it takes to render | The queue feeds whoever is there. A chunk goes to the first instance that answers; nobody waits for the whole fleet. An instance that does not answer within 15 minutes is replaced. |
| 2 | The platform has no instance to give yet | HTTP 503, "There is no Container instance available at this time." Seen 121 times while 152 instances were provided | It means "not ready yet". Nothing is counted against the chunk or the instance, and no spare instance is started. The chunk stays queued and is offered again on the next round. |
| 3 | A chunk hangs | The task stays "running" and never ends. Seen once: 15 minutes | Two limits. Deadline: `max(300 s, frames / 1.5 fps)`, or `chunkDeadlineSeconds`. No progress: no new frame for `max(150 s, deadline / 2)`. Past either, the instance is destroyed and replaced and the chunk is queued again. |
| 4 | An instance restarts | Its tasks and files are gone; the task server answers but does not know the task. 44 of 952 chunk runs in one job, most of them right after a deploy | The chunk is queued again. Chunks that were rendered there and not yet copied elsewhere are rendered again too. This is not the chunk's fault, so it does not use up `maxRetries` (see below). |
| 5 | A file arrives damaged | Right length, wrong bytes, after travelling container to Worker to container. No error anywhere. 89 of 1,800 transfers in one job; two outputs were wrong before the check existed | SHA-256 on both sides, everywhere: see "Checksums end to end". |
| 6 | A second run overwrites the first | A hedged copy of a chunk finished after the winner and wrote the same object key. The join then found a file that did not have the recorded hash | Every run writes its own files: see "One run, one set of files". |
| 7 | The plan request hits a platform error | "500 Error proxying request to container", "500 Failed to start container" | A 5xx answer to the plan is tried again (a plain 500 at most 5 times). Only a 4xx, which is the engine's own answer about the request, ends the render. |

## Hedging: a second run only for a run that is measurably slow

Hosts differ: the same chunk took 93 to 191 s on eight instances of one run. Starting a second run of a slow chunk
("hedging") shortens that tail. It is also the easiest way to waste money.

What the prototype did first: when most chunks were done, every idle process duplicated a chunk that was still
running. In two one-hour jobs that started **57 and 159 second runs. 1 and 0 of them finished first.** An earlier
job: 77 started, 1 won. Almost every one of them was CPU spent for nothing, and each was a chance for the overwrite
of row 6.

What this repository does (`hedge()` in the coordinator):

- A run gets a second run only when it is **measurably slow**: its frames per second since its first frame are under
  half the median of the finished chunks, or it has no first frame after three times the median time to the first
  frame.
- Not before a grace period (20 s, or twice the median time to the first frame).
- Only when nothing is queued and another instance has a free slot.
- Once per chunk.
- For at most `maxHedgeShare` of the chunks: 5 %, rounded up. A render of fewer than 20 chunks may hedge once.
- It needs 3 finished chunks before "slow" means anything.

The first result wins and the other run is cancelled. `hedges: { started, won }` in the progress tells you whether
your hedges are worth their cost. Turn it off with `duplicateStragglers: false`.

What truly protects a render from a stuck chunk is the deadline and the no-progress limit of row 3. Hedging only buys
time on a slow host.

## One run, one set of files

Every run of a chunk has a number: the first run is 1, a retry or a hedge is the next. The coordinator names the
files of a run: `chunk-0003-r2.ts` and `chunk-0003-r2.aac`. On the instance's disk and in object storage
(`renders/<id>/chunk-0003-r2.ts`) the name is the same. The same holds for the output of a single render
(`output-r1`) and of every attempt to join (`output-s0-0`).

So a run that finishes late can only ever write its own files. When a chunk is done, the coordinator records which
run won, and the join is told exactly those file names, with their sizes and hashes. Files of runs that lost are
never read. They are deleted with the render.

## Checksums end to end

| Hop | Check |
| --- | --- |
| Render process to its own disk | SHA-256 and MD5 of each file, computed by the task server when the task ends |
| Instance to instance, through the coordinator (no object storage) | The receiver answers with size and SHA-256 of what it stored. The coordinator compares with the sender's. Repeated up to 3 times, then the chunk is rendered again. The receiver writes under another name first and renames, so a broken transfer leaves nothing behind |
| Instance to R2 through the Worker's gateway | The SHA-256 travels in a header and R2 checks the body against it |
| Instance to R2 over a presigned URL | The ETag in the answer must be the MD5 of the file |
| R2 to the joining instance | Size and SHA-256 of every chunk are compared **before** the file gets its name, so before any byte is joined. 4 tries, then the join fails with `checksum_mismatch` |
| Output to the client | The client compares with `outputSha256` from the progress |

The code is `packages/core/src/transfer.ts`. On the R2 path the prototype saw no mismatch in 1,200 + 3,600 chunk
uploads and as many downloads. The damage of row 5 happened on the way into a container through a Durable Object.

## Retries and their limits

| Counter | Counts | Limit |
| --- | --- | --- |
| `attempts` of a chunk | runs that failed by the chunk's own fault: a render error, a deadline, no progress, a result that is not what was asked for, 3 damaged transfers | `maxRetries` (default 2) more runs, then the render fails |
| `lost` of a chunk | runs lost with their instance (a restart) | `3 x (maxRetries + 1)`, then the render fails |
| Stitch attempts | joins that failed or ran out of time | 3 |
| Stitchers lost | the instance that joins stopped answering or restarted | 6 |
| Instances | every instance the job ever started | `3 x instances + 2` while rendering |

A composition that throws on frame 512 will throw there three times. That is not something to retry forever. An
instance that Cloudflare restarts under a chunk says nothing about the chunk.

## CPU is billed from the instance, not from the tasks

A task reports the busy CPU of the **whole virtual machine** while it ran. Two tasks that share an instance each
include the other's CPU. Adding up task figures counts shared instances twice: one job's summary in the prototype
said 86,042 vCPU-seconds where 58,800 were used.

So `costs.cpuSeconds` in the progress is the sum over instances of each instance's own busy counter (`cpuSeconds` of
`GET /tasks`). The coordinator adds up the increases of that counter, so a task server that restarts and counts from
0 again loses nothing. `taskCpuSeconds` in the job state is kept for statistics and is the larger, wrong number for a
bill.

## The coordinator itself may restart

The coordinator holds nothing in memory between two rounds. Everything it knows is in the job, and the job is stored
after every round (Durable Object storage on Cloudflare). A Durable Object that is evicted or restarted continues
with the next alarm: runs in flight are polled again, and a task its instance no longer knows is row 4. There is a
unit test that serialises the job in the middle of a render and continues from the copy.

One limit to know: the job is one stored value. A Durable Object value holds up to 2 MB; a job with a few thousand
chunks approaches that (we did not measure where it breaks). For such jobs, store the chunks in pages
(`chunks/0000`, `chunks/0001`, 100 per page) and write only the pages that changed. The prototype does that; this
repository does not.

## What the client sees: errors as structured events

Every recovered problem is listed in `errors` with `fatal: false`. Every entry has a `kind` from a fixed list:

```json
{ "at": 1795802765017, "kind": "chunk_deadline", "chunk": 3, "attempt": 1, "instance": "r9f3-1",
  "message": "chunk 3 passed its deadline of 300 s at frame 12: instance replaced", "fatal": false }
```

| `kind` | Level | Meaning |
| --- | --- | --- |
| `hedge_started`, `hedge_won`, `job_cancelled` | info | normal work |
| `plan_error`, `instance_start_failed`, `instance_unresponsive`, `instance_restarted`, `chunk_failed`, `chunk_deadline`, `chunk_hung`, `transfer_error`, `coordinator_error` | warning | recovered; worth counting |
| `checksum_mismatch`, `stitch_error`, `job_failed` | error | a file or the render was at risk |

`fatalErrorEncountered: true` means the render stopped; its last entry is `job_failed`.

Group by `kind`, not by message text. `toTrackerEvent()` in `packages/core/src/events.ts` turns an entry into the
shape error trackers take: a kind, a level, a fingerprint (`kind:phase`), a message, flat properties (render id,
chunk, attempt, instance). The Worker writes one such JSON line per new event to its log, so Workers Logs can filter
on `kind` and a Tail Worker or Logpush can forward them. Sending them to a tracker is a few lines:

```ts
import { toTrackerEvent } from './packages/core/src/events.ts';

for (const error of progress.errors) {
  const event = toTrackerEvent(progress.renderId, error, { phase: progress.phase });
  if (event.level !== 'info') await tracker.capture({ type: event.kind, level: event.level, fingerprint: [event.fingerprint], message: event.message, tags: event.properties });
}
```

The entries carry ids, indexes and error text. They never carry file contents, input props or the query string of a
URL (a presigned URL is a credential; `transfer.ts` cuts it off before an error message is made).

## Failure drills: what to try on purpose before you trust it

Each drill below was run on Cloudflare `standard-4` by the prototype of this design (November 2026) against a
4-minute 1080p range of a mixed project. Run the same ones against your deployment; each should end in the stated
state and leave one structured event per failure.

| Drill | How | What must happen |
| --- | --- | --- |
| Instance killed mid-render | destroy two instances while their chunks render | their chunks run elsewhere, not counted as attempts; job ready |
| Corrupted chunk in storage | overwrite one chunk object with random bytes of the same size between its upload and the join | the join's SHA-256 check refuses it (after 3 fetches), the chunk is rendered again, the join runs again; the output's video stream was byte-identical to an uncorrupted run |
| Cancel mid-render | cancel while chunks run | every task stops, instances go back, no instance is started for the job afterwards |
| Upload killed | kill the client during a multipart upload, three times | the next run sends only the missing parts |
| Token expiry | a 25 s token during a 3-minute job | the old token gets 401 `token_expired`, a fresh one continues, an open progress stream is closed at the token's expiry |
| Isolation | user B's token against user A's job id | 403 for status, events, download and cancel; nothing of A's in the answers |
| Webhook down | the receiver answers 500 | the job is still ready; the webhook is tried three times, then one `webhook_failed` event |

Four bugs these drills found in the prototype, worth checking in any design like this one: an instance was started
for a job after the job had ended (a late "I need N instances" reached the pool); a progress stream outlived its
token; asking for part URLs of an upload id that storage does not know failed with a server error instead of 404; and
a frame range read the whole project's heavy seconds as "this range is all heavy" and started 40 instances for a plan
of 16.

## What ran where

- The failures above happened in the prototype, on Cloudflare.
- The fixes in this repository are exercised by unit tests against a simulated fleet (19 for the coordinator) and by
  local renders. Read the tests before you trust them.
- The hedge rule, per-run file names, the lost-run counter, the no-progress limit, the checked downloads and the
  SHA-256 on gateway uploads are new in this version. They ran locally on macOS and are checked by CI.
  **They have not run on Cloudflare in this code base.**

## Signals

The task server handles `SIGTERM`: it kills its render processes and exits. Cloudflare sends `SIGTERM` before it
stops an instance. The image starts with `dumb-init` so the signal reaches Node and finished browser processes are
reaped.
