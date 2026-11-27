# Mixing Remotion and HyperFrames

Remotion draws React components. HyperFrames seeks an HTML page with a paused GSAP timeline. Each has its own
renderer, its own browser build and its own idea of time. This repository does not try to run one inside the other.
It renders one of them first, to a video file, and gives that file to the other.

## Remotion as the host (built and tested: `examples/mixed`)

```
hyperframes-layer/  --hyperframes render --format webm-->  public/hf/layer-<hash>.webm   (VP9 with alpha)
                                                                   |
src/Mixed.tsx   <Video src={staticFile(hyperframesLayer)} />   ----+--> Remotion SSR, chunked like any Remotion video
```

### The pre-render step

`examples/mixed/layer.ts`, `ensureLayer()`:

1. Compute a name from a SHA-256 over the layer's source files, its variables, the frame rate and the HyperFrames
   version: `hf/layer-3d04043e6a37ef26.webm`.
2. If that file is already in the site's `public` folder, done.
3. Otherwise run `hyperframes render <layer> --format webm` and move the result into place in one step, so a
   half-written file is never seen.

The engine (`examples/mixed/engine.ts`) runs this before every render process and passes the file name to the
composition as the input prop `hyperframesLayer`.

### Alpha

- The layer's page must have `background: transparent` on `html`, `body` and the root element.
- `hyperframes render --format webm` writes VP9 with an alpha channel. `--format mov` writes ProRes 4444.
- In Remotion the layer is played with `<Video>` from `@remotion/media`, which decodes the alpha channel. Remotion's
  docs say this needs WebGL and that without it the tag falls back to `<OffthreadVideo>` during rendering
  (https://www.remotion.dev/docs/videos/transparency). We did not check which of the two ran in the container. What
  we checked is the result: the layer is transparent where it should be, in Docker on Linux and on Cloudflare, with
  Remotion's default GL setting.
- `ffprobe` reports the WebM as `yuv420p`. That is normal: VP9 keeps alpha in a side channel.

### Caching, and what a cache miss costs

| Where the layer comes from | When | Cost |
| --- | --- | --- |
| The image | default variables: `npm run site` renders the layer on the build machine and it is bundled into the site | none at render time |
| The instance's disk | the first render process on an instance with new variables renders it; the others on that instance wait for the file (a lock) | one HyperFrames render per instance |
| Nowhere yet | every instance of the job renders the layer once | measured below |

Measured on Cloudflare, the 8 s example on 2 instances: 58.6 vCPU-seconds with the layer in the image, 115.0 with
the layer rendered at job time on both instances. Wall time was nearly the same (35 s and 37 s) because the chunks
wait in parallel.

What we did not build: a shared cache. With R2 attached, the natural next step is to store the layer under its hash
in R2, so only the first instance ever renders it. With many instances per job that matters.

### Sound

In the example the layer is silent and the composition's `<Video>` is `muted`. A HyperFrames layer with its own sound
would carry it in the WebM; we did not test that.

### Isolation

The hash includes the variables, so two jobs with different text get different files and never see each other's
layer. Each instance has its own disk.

## HyperFrames as the host (documented, not built)

The same idea the other way round:

1. Render the Remotion composition with the Remotion example. For a layer with transparency use
   `codec: 'vp9'`, `imageFormat: 'png'`, `pixelFormat: 'yuva420p'` (https://www.remotion.dev/docs/transparent-videos).
   Such a render is not chunked here; it runs on one instance.
2. Put the file into the HyperFrames project's `assets/` and reference it as a normal clip:

   ```html
   <video id="remotion-layer" class="clip" data-start="2" data-duration="6" data-track-index="3" src="assets/remotion-layer.webm" muted playsinline></video>
   ```

3. Render the HyperFrames project with the HyperFrames example.

We did not run this. The parts are each tested on their own; the combination is not.

## What not to do

- Do not load a HyperFrames page in an `<iframe>` inside a Remotion composition and seek it per frame. We tried a
  version of this earlier: seeking is cheap, but 2 of 4 real templates gave different pixels for the same frame
  depending on the order the frames were visited, because they animate on CSS or `requestAnimationFrame` time, which
  HyperFrames freezes with its own shim while it captures.
- Do not expect the two frameworks to share fonts or state. Each layer loads what it needs.
