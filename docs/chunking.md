# Chunking and joins

One video is split into frame ranges ("chunks"), equal for Remotion. Each chunk is rendered by its own process, on any instance.
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

The joined audio is also **a few AAC frames longer than the video**: 2048 or 4096 samples (43 or 85 ms at 48 kHz)
on a whole timeline, 53 to 96 ms on a range that does not start at frame 0. That is the AAC frame padding of
Remotion's seamless join, identical in `combineChunks()` itself. Leave it: an exact trim needs an edit list (which a
streamed fragmented MP4 cannot carry reliably) or a re-encode of the audio, and dropping whole AAC packets cuts at
21 ms steps and can cut real sound. Players stop at the end of the video.

Earlier, with a different and longer composition, we measured 24 chunks from 8 instances over 10 minutes:
18,000 of 18,000 frames, every flash on its frame, no audio drift over 23 joins.

## HyperFrames

Pure HyperFrames videos are chunked too, since the version after 0.1.0, with HyperFrames' own distributed primitives
(`@hyperframes/producer/distributed`, the functions behind `hyperframes lambda` and `hyperframes cloudrun`). The
contract is different from Remotion's, and simpler:

| | Remotion | HyperFrames |
| --- | --- | --- |
| A chunk renders | `renderMedia()` with a `frameRange` | `renderChunkV2()` with a `frameRange`: fresh seek per frame under HyperFrames' virtual-time shim |
| Chunk video | `h264-ts`, timestamps on the timeline | closed-GOP MP4 rewrapped as MPEG-TS (no re-encode), timestamps at `startFrame / fps` |
| Chunk audio | a padded `.aac` per chunk (`forSeamlessAacConcatenation`) | none: HyperFrames mixes the whole timeline once while it plans |
| Second file | the `.aac` | a `.json` description: frames, plan hash, size, SHA-256 of the video |
| Chunk lengths | equal, except the last | any: heavy ranges can get shorter chunks |
| Join | `combineChunks()` or the streaming join | chunks byte after byte into FFmpeg, video copied, the single audio track muxed |

The full description, the rules a composition must follow (time from the timeline, seeded randomness, fonts in the
project), the measurements and the limits: [hyperframes-split.md](hyperframes-split.md).

Do not cut a HyperFrames video into `hyperframes render --start/--end` ranges and concatenate the files yourself:
each file has its own audio and its own encoder settings, and nothing guarantees the joins. `"split": false` keeps the
old way: one `hyperframes render` per video on one instance, for WebM, MOV and the other formats.

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
