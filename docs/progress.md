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

`overallProgress` is 1 only when the output file exists and its hash is known. `phase` is one of `planning`,
`rendering`, `stitching`, `done`, `failed`.

For HyperFrames the frame count comes from the percentage the HyperFrames CLI prints (`@hf-progress` lines). It is
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
