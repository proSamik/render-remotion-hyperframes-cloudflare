# Chunking and joins

One video is split into equal frame ranges ("chunks"). Each chunk is rendered by its own process, on any instance.
One instance then joins them. This page says what makes the join seamless, for picture and for sound.

## Remotion

Remotion documents the contract at https://www.remotion.dev/docs/distributed-rendering. This repository follows it
in `packages/cloudflare-containers/container/engine.ts`.

Per chunk, `renderMedia()` gets:

| Option | Value | Why |
| --- | --- | --- |
| `codec` | `'h264-ts'` | An MPEG-TS stream can be joined byte for byte. MP4 chunks do not join: in our first test only the first chunk's video came out. |
| `frameRange` | `[chunkStart, chunkEnd - 1]` | Inclusive, as always in Remotion. |
| `compositionStart` | first frame of the WHOLE export | The same number for every chunk. Not the chunk's own start. With the chunk start the audio joins were wrong. |
| `separateAudioTo` | `chunk-0003-r1.aac` | Audio leaves as its own file. Every run of a chunk has its own file names (`-r1`, `-r2` for a retry or a hedge), so a late run cannot overwrite the one that won. |
| `forSeamlessAacConcatenation` | `true` | Remotion pads each chunk's audio to whole AAC frames and renders a little extra on both sides. |
| `audioCodec` | `'aac'` | |
| `enforceAudioTrack` | `true` | A silent chunk still needs an audio file, or the join shifts. |
| `gopSize` | `fps` | The same closed GOP length in every chunk. |

Rules that follow from Remotion's docs:

- Every chunk has the same number of frames, except the last. The coordinator plans a fixed grid
  (`planning()` in `packages/core/src/coordinator.ts`). There is a unit test for it.
- Every chunk gets the same options and the same input props.
- A chunk must be longer than 4 frames for the seamless AAC path. The coordinator never plans less than 30.

Join: `combineChunks()` from `@remotion/renderer` (since v4.0.279). It copies the video streams and trims the audio
padding. Pass `codec: 'h264'` there, not `'h264-ts'`. It needs `framesPerChunk`, `compositionDurationInFrames`,
`fps`, and `frameRange` when you did not render the whole composition.

`combineChunks()` needs every chunk and the output on one disk. For videos where that does not fit there is a
streaming join that gives the same file: [long-videos.md](long-videos.md).

Only H.264 is chunked here. Any other codec (`vp9`, `prores`, `gif`, audio only) is rendered in one piece on one
instance. That is a limit of this repository, not of Remotion.

### What we verified

The example sound track is a steady tone with a beep at every second (`packages/core/scripts/make-tone.mjs`).
A click or a gap at a join would show in the waveform. `packages/core/scripts/verify.mjs` checks it.

| Run | Frames | Joins | Largest sample step at a join | Beeps |
| --- | --- | --- | --- | --- |
| Mac, 1 process group, 3 chunks | 300 of 300 | 2 | 0.0035, the same as anywhere else in the tone | 10 of 10 |
| Mac, 2 local instances, 4 chunks | 300 of 300 | 3 | same | 10 of 10 |
| Docker on Linux x86-64, 2 containers, 3 chunks | 90 of 90 | 2 (both on a beep) | 0.061, equal to the beep itself | all |
| Cloudflare, 1 instance, 3 chunks | 300 of 300 | 2 | 0.0035 | 10 of 10 |
| Cloudflare, 4 instances, 12 chunks, 60 s | 1800 of 1800 | 11 | never above the track's own largest step | 60 of 60 |

In every run the beeps arrive 45.6 ms after their second mark, by the same amount from the first beep to the last.
So nothing drifts. The constant offset is there in a single unchunked render too. It is not caused by chunking.
We did not find out where it comes from.

Earlier, with a different and longer composition, we measured 24 chunks from 8 instances over 10 minutes:
18,000 of 18,000 frames, every flash on its frame, no audio drift over 23 joins.

## HyperFrames

`hyperframes render` renders a composition on one machine and uses several browser workers there (`--workers`).
The HyperFrames example therefore runs one render on one instance. It is not chunked by this repository.

HyperFrames does have distributed rendering of its own: `@hyperframes/producer/distributed` exports `plan`,
`renderChunk` and `assemble`, and the `hyperframes lambda` and `hyperframes cloudrun` commands are built on them
(https://hyperframes.heygen.com, deploy section). We did not wire those functions into this coordinator and did not
test them on Cloudflare. If you need a long HyperFrames video faster than one instance renders it, that is the place
to start. Do not cut a HyperFrames video into `--start/--end` ranges and concatenate them yourself: nothing
guarantees the audio joins.

To render many HyperFrames videos at once, start many renders. Each one gets its own instance.

## Mixed

The host decides. In the mixed example Remotion is the host, so the video is chunked exactly like a Remotion video.
The HyperFrames layer is an ordinary video file by then. See [mixed.md](mixed.md).

## Choosing a chunk size

Default: `frames / (instances x processesPerInstance)`, at least 30 frames. So 4 instances with 3 processes each
give 12 chunks.

- A chunk costs a browser start and a composition load before its first frame: 3 to 7 s in a warm instance in our
  earlier measurement. Very small chunks waste that.
- A lost chunk is rendered again from its start. Very large chunks make a retry expensive.
- Chunks of 5 to 30 seconds worked well for us.
