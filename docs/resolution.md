# Output resolution: previews and finals

One option decides how many pixels you pay for: the output size. This page says how to offer it, what it changes
in a chunked render, and what it really costs, measured.

In this repository: `packages/core/src/resolution.ts` turns a name into Remotion's `scale`, the output size and a
bitrate, and moves planner rates to another size (unit tests in `packages/core/test/resolution.test.ts`). Pass
`scale` and `videoBitrate` to the render (`--scale`, `--video-bitrate` on the CLI).

## The option

| Name | Short side | 16:9 output | Bitrate (30 fps, x264 `veryfast`, 1 s GOP) |
| --- | ---: | --- | ---: |
| `360p` | 360 | 640 x 360 | 1 Mbit/s |
| `480p` | 480 | 854 x 480 | 2.5 Mbit/s |
| `720p` | 720 | 1280 x 720 | 5 Mbit/s |
| `1080p` | 1080 | 1920 x 1080 | 10 Mbit/s |
| `1440p` (`2k`) | 1440 | 2560 x 1440 | 16 Mbit/s |
| `2160p` (`4k`) | 2160 | 3840 x 2160 | 35 Mbit/s |
| `composition` (default) | the composition's | unchanged | by size |

The name is the **short side**, so a portrait 1080 x 1920 composition at `1080p` stays 1080 x 1920.

## Rules for a chunked render

1. **One scale for the whole job.** The join copies the chunks' streams. A chunk of another size makes a broken file,
   so compute the scale once and give every chunk, every sample render and the join the same value. A cheap check:
   probe each chunk's width and height before the join.
2. **Even sides without cropping.** H.264 needs even sides. Remotion rounds `side x scale`, and when the result is odd
   it takes pixels off the composition until it is even: 1920 x 1080 at `scale` 0.4444 gives 852 x 480, with two
   columns cut. `outputSize()` picks a scale that lands on 854 x 480 exactly.
3. **Pre-rendered layers above the composition size.** Anything rendered to a video before the main render
   (HyperFrames proxies, overlays) must be rendered for the output size when the output is larger than the
   composition. Otherwise a 4K output shows a 1080p layer upscaled, and its text is soft. Give the pre-render a target
   of `layer box x scale`; HyperFrames turns that into a whole-number capture scale (2 for both 1440p and 4K of a
   1080p canvas, so the two can share a cache). At or below the composition's size, keep the normal proxy.
4. **Stream the join for big outputs.** 4K at 35 Mbit/s is 15.75 GB an hour, which with its chunks does not fit a
   `standard-4` disk. Use the streaming join ([long-videos.md](long-videos.md)).
5. **Memory.** On `standard-4` (12 GiB), two 4K render processes per instance ran an 11-minute mixed range with no
   failure or restart: chunks of 6 s, the longest 2:41.

## What it costs: not linear in pixels

A frame has a fixed part (React, layout, seeking video, WebGL draw calls) and a part that grows with pixels (raster,
screenshot, JPEG, x264). Measured by the prototype of this design on Cloudflare `standard-4`: the same 4-minute mixed
range sampled at every size (12 short sample renders per size), relative to 1080p:

| Output | Pixels vs 1080p | Footage, text, motion graphics: fps / CPU per frame | Cheap WebGL: fps / CPU | Heavy WebGL (shader effects, 3D): fps / CPU |
| --- | ---: | --- | --- | --- |
| 360p | 0.11x | 1.43x / 0.65x | 1.49x / 0.76x | 1.16x / 0.91x |
| 480p | 0.20x | 1.28x / 0.74x | 1.43x / 0.78x | 1.14x / 0.91x |
| 720p | 0.44x | 1.11x / 0.91x | 1.18x / 0.93x | 1.02x / 0.97x |
| 1080p | 1x | 1 | 1 | 1 |
| 1440p | 1.78x | 0.70x / 1.56x | 0.75x / 1.31x | 0.93x / 1.06x |
| 2160p | 4x | 0.43x / 2.41x | 0.48x / 1.84x | 0.73x / 1.23x |

So a 480p preview of footage costs about three quarters of the 1080p render, not a fifth, and a 480p preview of heavy
WebGL effects costs about 90 %: the shaders do the same work whatever the output size. 4K costs about 2.4x for
footage and 1.2x for heavy effects. `RESOLUTION_FACTORS` holds this table; measure your own content the same way
(render a few seconds of each kind at each size, read fps and CPU seconds).

With a tier that is a finish time ([planning.md](planning.md)), a cheaper size gives a **smaller fleet** and about
the same wall time, not a faster result. If you want a preview that is ready sooner, pick a faster tier for it too.

## Measured: one 1:44:00 project at 480p, 720p and 1080p, and 11 minutes at 4K

The 1:44:00 mixed project of the README (187,200 frames at 30 fps), Standard tier, inputs already in R2, November 2026.
Downloads are limited by the test machine's line, which was slower during the 480p, 720p and 4K runs (3.2 to 5.2 MB/s)
than during the 1080p run (6.8 MB/s). Durations h:mm:ss or mm:ss.

| Output | Video length | Final video | Upload | Render (start to download link) | Download | Total | Cloudflare cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 480p (854 x 480) | 1:44:00 | 2.23 GB | 0:16 | 8:08 | 11:42 | 20:22 | $1.59 |
| 720p (1280 x 720) | 1:44:00 | 4.14 GB | 0:15 | 7:03 | 13:20 | 20:55 | $1.68 |
| 1080p (1920 x 1080) | 1:44:00 | 7.99 GB | 5:49 (first upload) | 7:36 | 19:35 | 33:18 | $2.23 |
| 2160p (3840 x 2160), first 11 minutes | 11:00 | 2.90 GB | 0:16 | 4:41 | 12:29 | 17:43 | $0.56 |
| 1080p, the same 11 minutes | 11:00 | 0.84 GB | 0:17 | 3:05 | not downloaded | | $0.28 |

Reading it: on the whole project 480p cost 71 % and 720p 75 % of 1080p, with files 28 % and 52 % of its size. The same
11 minutes at 4K cost 2.0x the 1080p render (the range is heavy with effects and 3D, which scale least) and the file
is 3.4x larger. Start to download link stays near the tier's finish-time target at every size, because the fleet
follows the work: 52 instances at 480p, 64 at 720p, 83 at 1080p.

Every output was checked: exact frame count, a keyframe at every join, contiguous audio, no join artefact, and frames
against reference images. Below 1080p one more frame scored lower than at 1080p: a 1-2 px scanline effect that the
small output draws but the reference loses when it is scaled down for the comparison. When you check a preview
against full-size references, expect fine patterns to differ.

## Previews first

Render a quick **480p or 720p preview** for approval, then the final at full size:

- The preview's file is a quarter to a third of the final's size, so it downloads and shares sooner. On a slow
  line the download is often longer than the render.
- Its compute is 70 to 90 % of the final's (table above), not a fifth. Previews are cheaper, not free.
- Use the same project and range for both. Only `scale` and bitrate change, so the final shows exactly what was
  approved, only sharper.
- Show the estimate for both before rendering. A sample render at the chosen size measures that size's cost
  directly.
