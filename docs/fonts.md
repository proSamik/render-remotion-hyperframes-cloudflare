# Fonts

A container has only the fonts its image installs. This is the most common reason a cloud render looks different
from the render on your Mac or Windows machine.

Remotion's Docker page puts it this way: "If no font is installed, text renders invisibly without an error."
(https://www.remotion.dev/docs/docker)

## Rules

1. Never rely on a font that is only on your machine: Arial, Helvetica, SF Pro, Segoe UI, Impact and so on are not
   in a Debian image, and their licences do not allow copying them to a server.
2. Ship the fonts your design needs with the project, as files with an open licence.
3. Wait for the font before the first frame.
4. Install an open baseline in the image for everything else (fallbacks, emoji, other scripts).

## Remotion

Load a file from `public/` and block the render until it is ready. `examples/remotion-only/src/WebFont.tsx`:

```tsx
import { loadFont } from '@remotion/fonts';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

const handle = delayRender('Loading Archivo Black');
loadFont({ family: 'Archivo Black', url: staticFile('fonts/ArchivoBlack-Regular.ttf') })
  .then(() => continueRender(handle))
  .catch((error) => cancelRender(error));
```

Remotion renders with several browser tabs and each chunk is a separate browser. Tabs do not share state. Code at
module level runs in every tab, so every tab loads the font.

Google Fonts work too: `@remotion/google-fonts` with `loadFont()` and `waitUntilDone()`
(https://www.remotion.dev/docs/google-fonts/load-font). Ask only for the weights and subsets you use, or the request
is large and can time out. This needs outbound Internet from the container (`ENABLE_INTERNET` is `"true"` in the
example `wrangler.jsonc`). A font file in `public/` needs no network and cannot fail that way. We tested the file
route on Cloudflare, not the Google route.

Measure text (`measureText`, layout that depends on text width) only after the font is loaded.

## HyperFrames

Put the file in the project and declare it with `@font-face`, as `examples/hyperframes-only/composition/index.html`
does. HyperFrames resolves a small set of bundled families by name and fetches Google Fonts families during its
compile step (we saw it fetch Inter for `sans-serif`), which also needs outbound Internet.

## The image baseline

The example Dockerfiles install:

| Package | Gives |
| --- | --- |
| `fonts-liberation` | Liberation Sans, Serif, Mono. Same widths as Arial, Times New Roman, Courier New, so `sans-serif` text wraps like Arial. |
| `fonts-noto-core` | Noto Sans and Serif for many scripts. |
| `fonts-noto-color-emoji` | Emoji. |

Add `fonts-noto-cjk` for Chinese, Japanese and Korean (about 90 MB). Remotion Lambda ships a similar set
(https://www.remotion.dev/docs/lambda/runtime).

## If you must match a proprietary font

There is no free way. The copies that come with Windows and macOS may not be put on a server (Microsoft's font FAQ,
Apple's macOS licence). Either buy a server licence from the font's owner, or switch the design to an open family and
use the same file on your machine and in the cloud. Open families with the same metrics exist for some:
Liberation Sans or Arimo for Arial, Liberation Serif or Tinos for Times New Roman, Gelasio for Georgia, Carlito for
Calibri. For Arial Black and Impact there is no metric-compatible open font; Archivo Black and Anton are close in
weight and look.

## Check what you got

Render a still and look at it:

```bash
node ../../packages/cloudflare-containers/bin/remotion-cloudflare.mjs still WebFont --frame=100 --out=out/font-check.png
```
