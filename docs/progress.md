# Progress reporting

`GET /renders/<id>` (or `getRenderProgress()`) answers at any time:

```json
{
  "renderId": "rb77f84bae2e1",
  "done": false,
  "overallProgress": 0.32,
  "phase": "rendering",
  "framesRendered": 633,
  "frames": 1800,
  "chunks": { "total": 12, "rendered": 0, "stored": 0, "running": 12 },
  "hedges": { "started": 0, "won": 0 },
  "instances": 4,
  "fatalErrorEncountered": false,
  "errors": [],
  "outputFile": null,
  "outputSizeInBytes": null,
  "outputSha256": null,
  "timeToFinish": null,
  "costs": { "accruedSoFar": 0.0025, "currency": "USD", "cpuSeconds": 61.2, "instanceSeconds": 44.1, "disclaimer": "..." }
}
```

## How the percentage is made

By frames, not by chunks, so it moves smoothly:

- 90 %: frames rendered, summed over all chunks. A running chunk reports its own frame count about twice a second.
- 5 %: chunks that have arrived where they will be joined.
- 5 %: the join.

`overallProgress` is 1 only when the output file exists and its hash is known. Until then it stops at 0.999.
`phase` is one of `planning`, `rendering`, `stitching`, `done`, `failed`.

## The percentage never goes backwards

Work can be lost: an instance restarts and its three finished chunks are rendered again. `framesRendered` and
`chunks` show that honestly, so they can go down. `overallProgress` does not. The coordinator stores the highest
value it has reported (`progressHigh` in the job state) and never reports less. A progress bar that jumps back from
70 % to 55 % reads as a broken product; a bar that waits at 70 % reads as work.

Three rules, if you build your own number on top:

1. Keep the high-water mark where the state is stored, not in the client. Two clients, or one client after a reload,
   must see the same number.
2. A status that is older than one already shown is dropped. A late answer to a poll can arrive after a newer one.
3. 100 only when the result is verified. A failed or cancelled render freezes the number where it was.

### One number over upload, render and download

A client that uploads inputs first and downloads the result afterwards wants one bar for all of it. The phases have
no common unit, and their lengths are not known in advance (how long will the render take? how large is the output?).
Estimating each phase in seconds and showing `done / total` makes the bar jump back whenever an estimate grows.

What worked in the prototype: advance by increments. For each update, with `work` = seconds of progress since the
last update and `remaining` = the current estimate of what is left:

```ts
percent += (1 - percent) * work / (work + remaining);
```

A later phase that turns out longer makes the next steps smaller. It never takes anything back. Weigh the phases in
seconds: upload = bytes / measured speed, render = frames left / frames per second from the progress, join = a few
percent of the render, download = size / measured speed. This repository's client does not upload inputs, so it shows
the service's own number.

For a split HyperFrames render the frame count of a chunk is the number of frames HyperFrames has captured so far
(files in its work folder, counted once a second): HyperFrames' distributed renderer has no progress callback. For a
render with `"split": false` it comes from the percentage the HyperFrames CLI prints (`@hf-progress` lines), which is
coarser: the CLI reports stages, not every frame.

## Where the numbers come from

1. The render process calls back per frame (`onProgress` of `renderMedia`).
2. It writes the count to a small file at most twice a second.
3. The task server reads the file when the coordinator polls (`GET /tasks?job=<id>`).
4. The coordinator (a Durable Object alarm every 1.5 s) stores the job state.
5. Your request reads the stored state. It does not touch the containers, so polling it is cheap and cannot disturb
   a render.

Polling, not push: the coordinator asks, the containers answer. A container that stops answering is noticed the same
way. Other implementations let the containers push progress to the Durable Object through an outbound handler; that
saves requests and needs the poll anyway to notice a dead container.

## Polling from a client

Every 2 seconds is plenty. The CLI does that. There are no webhooks in this repository; Remotion Lambda has them.

## Errors in the progress

`errors` lists what went wrong and what was done about it, each entry with a `kind` you can count and send to an
error tracker. See [failures.md](failures.md#what-the-client-sees-errors-as-structured-events).
