# GL backends: how Chromium draws without a GPU

A Cloudflare container has no GPU. How Chromium draws anyway is the largest single cost factor we found. Remotion
exposes the choice as `chromiumOptions.gl` (https://www.remotion.dev/docs/gl-options).

## Short version

| Your composition | Use | How |
| --- | --- | --- |
| No WebGL (text, shapes, images, video, CSS) | Remotion's default: no GL flag, Chromium rasters on the CPU | nothing to do |
| WebGL (three.js, shaders, maps) | `swangle` (SwiftShader) | `webgl: true`, or `--webgl` on the command line |
| WebGL, when its cost matters | `angle-egl` (Mesa llvmpipe); it needs a second browser in the image | build with `WEBGL_CHROME_VERSION`, see below |

Do not set `swangle` for content without WebGL. It is what Remotion Lambda and Cloud Run use for everything, and on
this platform it costs more.

`webgl` can be `true` for the whole video or a list of inclusive frame ranges, `[[300, 449]]`. The engine picks the
backend per chunk, so only the chunks that contain WebGL pay for it (`glFor()` in
`packages/cloudflare-containers/container/engine.ts`).

## What we measured with this repository's examples

Cloudflare `standard-4`, 2026-11-28, Remotion 4.0.530, 20 s at 1080p30, JPEG quality 90, x264 `veryfast`.

| Composition | GL | Processes | Wall s | vCPU-s | vCPU-s per output second |
| --- | --- | --- | --- | --- | --- |
| `Shapes` (no WebGL) | default | 3 | 31.8 | 58.3 | 2.9 |
| `Shapes` (no WebGL) | `swangle` | 3 | 36.5 | 94.3 | 4.7 |
| `Cube` (three.js, one cube and a torus) | `swangle` | 2 | 49.9 and 53.0 (two runs) | 138.7 and 145.0 | 6.9 to 7.3 |
| `Cube` | `angle-egl` with Google's chrome-headless-shell 158 | 2 | 54.1 | 109.5 | 5.5 |

Reading:

- Without WebGL, `swangle` cost 1.6 times the CPU of the default.
- For this light three.js scene, llvmpipe used about a quarter less CPU than SwiftShader and took about as long.
  The two outputs agree (SSIM 0.9988).
- A 5 s `Cube` with no GL flag at all also rendered: Chromium fell back to SwiftShader by itself, at the cost of
  `swangle`. Chromium logs that this automatic fallback is deprecated, so say `swangle` explicitly.

## What we measured earlier, with heavier content

Same platform, November 2026, Remotion 4.0.530 with Google's chrome-headless-shell 152, 20 s at 1080p30, real compositions
in a private prototype of this design. vCPU-seconds per output second, 2 tabs:

| Content | default | `angle` | `swangle` | `angle-egl` |
| --- | --- | --- | --- | --- |
| Camera footage with captions | 6.22 | 6.31 | 12.28 | 10.86 |
| Motion graphics | 10.98 | 10.75 | 60.22 | 31.20 |
| Pre-rendered layers composited | 4.90 | 4.87 | 8.10 | 7.29 |
| A 3D device model (GLB, WebGL) | 73.48 | fails | 74.86 | 31.55 |

Reading:

- Without WebGL the default was cheapest; `swangle` cost 1.7 to 5.5 times more.
- For the heavy 3D model, llvmpipe was 2.4 times cheaper than SwiftShader (2.8 times at each one's best setting),
  and the frames agreed (SSIM 0.9969).
- `angle` alone could not create a WebGL context: the render failed at the first frame.

So the llvmpipe advantage depends on the scene: 2.4 times for a heavy model, 1.3 times for a cube. Measure yours.

## `angle-egl` needs a different browser

This surprised us. With the browser Remotion downloads (4.0.530 ships its own Chromium 149.0.7790.0 build),
`angle-egl` does not start in a container:

```
ERROR:ui/gl/gl_display.cc:673] Initialization of all (0) EGL display types failed.
```

and three.js then throws inside `new WebGLRenderer`. We saw this in Docker on Linux and on Cloudflare. Mesa was
installed (`libegl1 libgles2 libgl1-mesa-dri`).

With one of Google's chrome-headless-shell builds (we tried 158.0.8127.88; the earlier measurement used
152.0.7977.54) the same flags give `ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 256 bits), OpenGL ES 3.2)`.

So this repository does it like this:

- The image may contain a second browser at the path in `REMOTION_WEBGL_BROWSER_EXECUTABLE`.
- If that file exists, chunks marked as WebGL use it with `angle-egl`. Everything else uses Remotion's own browser.
- If it does not exist, WebGL chunks use `swangle` in Remotion's own browser.

To add the second browser to the Remotion image:

```bash
docker build --platform linux/amd64 --build-arg WEBGL_CHROME_VERSION=158.0.8127.88 -f examples/remotion-only/Dockerfile -t rrh-remotion-only .
```

It adds about 250 MB. The mixed image already has such a browser, because HyperFrames installs one, and uses it.

### Pin the browser, in one place, and prove it

"Which browser can use Mesa" is not a property of a Chrome version number. It differed between two builds of nearby
versions (above), and nothing fails until a render reaches `new WebGLRenderer`. Three rules came out of that:

1. **One browser, one version, pinned in one place.** A build argument (`WEBGL_CHROME_VERSION` here) or a small JSON
   file that both the Dockerfile and the code read. Not "latest", not whatever a package downloads on first use.
   When an image holds Remotion and HyperFrames, point both at the same binary: `REMOTION_WEBGL_BROWSER_EXECUTABLE`
   for the WebGL chunks here, `HYPERFRAMES_BROWSER_PATH` and `PRODUCER_HEADLESS_SHELL_PATH` for HyperFrames. The
   mixed example does that.
2. **Test it as the last step of the image build.** The build fails, not the render:

   ```dockerfile
   COPY packages/core/scripts/webgl-selftest.mjs /app/webgl-selftest.mjs
   RUN node /app/webgl-selftest.mjs --browser /usr/local/bin/chrome-headless-shell-webgl --gl angle-egl --require-renderer llvmpipe
   ```

3. **Test it again when the instance starts.** The host is not the build machine. Set `RENDER_SELFTEST` to the same
   command (in the Dockerfile's `ENV`, or in `CONTAINER_ENV`). The task server runs it once at start and answers
   `503` on every route until it has passed, so the coordinator gives the instance no work. A failed self-test is
   not repeated: the instance stays `503` and is replaced.

`packages/core/scripts/webgl-selftest.mjs` needs nothing but the browser. It opens a page that creates a WebGL2
context, clears it to one colour, reads the pixel back and reads the renderer string:

```json
{ "ok": true, "gl": "angle-egl", "renderer": "ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 256 bits), OpenGL ES 3.2)",
  "version": "WebGL 2.0 (OpenGL ES 3.0 Chromium)", "pixel": [51, 153, 255, 255], "seconds": 1.4, "problems": [] }
```

That output is what the prototype's image printed with chrome-headless-shell 152.0.7977.54, at every build and at
every start (1.2 to 1.9 s). In this repository the script ran on macOS only: with Remotion's browser, `angle` gave
the Metal renderer, `swangle` gave SwiftShader, and `angle-egl` failed with "no WebGL2 context", as it should on a
Mac. The start hook has a unit test. **Neither ran in an image build or on Cloudflare here**, and the example
Dockerfiles do not call the script yet.

Rendering with a browser build that Remotion did not test is outside what Remotion supports. Keep `swangle` as the
fallback: `chromiumOptions: { gl: 'swangle' }` or `--gl=swangle` overrides the automatic choice.

## Processes for WebGL

Software WebGL fills the instance with fewer processes. Use `processesPerInstance: 2`. See
[concurrency.md](concurrency.md).

## HyperFrames

HyperFrames chooses its own flags. In a container it runs Chrome in software mode
(`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`, from its source) and its render summary says
`software gpu`. We did not change that.
