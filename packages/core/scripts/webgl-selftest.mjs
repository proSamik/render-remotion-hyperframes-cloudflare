#!/usr/bin/env node
/**
 * Proves that a browser binary can do WebGL with a GL backend, on this machine, right now.
 *   node webgl-selftest.mjs --browser <chrome-headless-shell> [--gl angle-egl|swangle|angle] [--require-renderer llvmpipe]
 * It starts the browser on a page that creates a WebGL2 context, clears it to one colour, reads a pixel back and
 * reads the renderer string. Prints one JSON document; exit code 1 when anything is wrong.
 *
 * Why: "which browser build can use Mesa" changes between Chrome versions and between builds of the same version, and
 * the failure shows late, as `new WebGLRenderer` throwing inside a render. Run this as the LAST step of the image build
 * (the build fails instead of the render) and again when the task server starts (RENDER_SELFTEST, see
 * container-server.ts). Pin the browser version in ONE place and let both the Dockerfile and this check read it.
 *
 * It needs nothing but the browser: no Remotion, no HyperFrames, no puppeteer. The flags per backend are the ones
 * Remotion passes for `chromiumOptions.gl`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GL_FLAGS = {
  'angle-egl': ['--use-gl=angle', '--use-angle=gl-egl'],
  swangle: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  angle: ['--use-gl=angle'],
};
const PAGE = `<!doctype html><pre id="result"></pre><script>
  const out = {};
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('no WebGL2 context');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    out.renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.version = gl.getParameter(gl.VERSION);
    gl.clearColor(0.2, 0.6, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    out.pixel = [...pixel];
    out.userAgent = navigator.userAgent;
  } catch (error) { out.error = String(error.message || error); }
  document.getElementById('result').textContent = JSON.stringify(out);
</script>`;

/** -> { ok, gl, browser, renderer, version, pixel, userAgent, seconds, problems } */
export function webglSelfTest({ browser, gl = 'angle-egl', requireRenderer = null, timeoutMs = 60_000 }) {
  const started = Date.now();
  const base = { ok: false, gl, browser, problems: [] };
  if (!browser || !existsSync(browser)) return Promise.resolve({ ...base, problems: [`no browser at ${browser}`] });
  if (!GL_FLAGS[gl]) return Promise.resolve({ ...base, problems: [`unknown gl "${gl}" (${Object.keys(GL_FLAGS).join(', ')})`] });
  const args = ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-webgl', ...GL_FLAGS[gl], '--dump-dom', `data:text/html;base64,${Buffer.from(PAGE).toString('base64')}`];
  return new Promise((resolve) => {
    execFile(browser, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const seconds = (Date.now() - started) / 1000;
      const match = /<pre id="result">([^<]*)<\/pre>/.exec(String(stdout));
      let result = null;
      try { result = match ? JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) : null; } catch { /* reported below */ }
      const problems = [];
      if (!result) problems.push(`the browser gave no result${error ? `: ${error.message.split('\n')[0]}` : ''}; ${String(stderr).trim().split('\n').filter((line) => /ERROR|error/.test(line)).slice(-3).join(' | ')}`.trim());
      else if (result.error) problems.push(result.error);
      else {
        if (JSON.stringify(result.pixel) !== '[51,153,255,255]') problems.push(`the pixel read back is ${JSON.stringify(result.pixel)}, expected [51,153,255,255]`);
        if (requireRenderer && !String(result.renderer).toLowerCase().includes(String(requireRenderer).toLowerCase())) problems.push(`the renderer is "${result.renderer}", expected one that contains "${requireRenderer}"`);
      }
      resolve({ ...base, ...(result ?? {}), ok: problems.length === 0, seconds, problems });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = (name) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };
  const report = await webglSelfTest({ browser: flag('browser') ?? process.env.REMOTION_WEBGL_BROWSER_EXECUTABLE ?? process.env.HYPERFRAMES_BROWSER_PATH, gl: flag('gl') ?? 'angle-egl', requireRenderer: flag('require-renderer') ?? null });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
