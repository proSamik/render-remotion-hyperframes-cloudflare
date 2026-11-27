import assert from 'node:assert/strict';
import { test } from 'node:test';
import { glFor, resolveServeUrl } from '../container/engine.ts';
import { estimatePrice, estimatePriceForDuration } from '../src/api/estimate-price.ts';
import { toJobRequest } from '../src/api/render-media-on-cloudflare.ts';

test('estimatePrice: CPU by use, memory and disk by instance time (standard-4 list prices)', () => {
  // 100 vCPU-seconds and 30 instance-seconds: 100 * 0.00002 + 30 * (12 * 0.0000025 + 20 * 0.00000007)
  assert.equal(estimatePrice({ cpuSeconds: 100, instanceSeconds: 30 }), 0.002942);
  assert.throws(() => estimatePrice({ cpuSeconds: -1, instanceSeconds: 0 }));
});

test('estimatePriceForDuration reproduces the measured cost per output minute', () => {
  assert.equal(Math.round(estimatePriceForDuration({ durationInSeconds: 60, content: 'footage-with-captions' }) * 10000) / 10000, 0.0107);
  assert.equal(Math.round(estimatePriceForDuration({ durationInSeconds: 60, content: 'webgl-angle-egl' }) * 10000) / 10000, 0.0436);
});

test('toJobRequest separates render options from fleet options and never forwards the secret', () => {
  const request = toJobRequest({ serviceUrl: 'https://x', secret: 'do-not-forward', composition: 'Shapes', inputProps: { a: 1 }, concurrency: 4, framesPerChunk: 120, maxRetries: 1 });
  assert.deepEqual(request.fleet, { instances: 4, framesPerChunk: 120, maxRetries: 1 });
  assert.equal(JSON.stringify(request).includes('do-not-forward'), false);
  assert.equal(request.render.composition, 'Shapes');
});

test('glFor: default without WebGL; with WebGL angle-egl only when a browser that supports it is installed', () => {
  assert.equal(glFor({}, 0, 100, 'linux', null), null);
  assert.equal(glFor({ webgl: true }, 0, 100, 'linux', null), 'swangle');
  assert.equal(glFor({ webgl: true }, 0, 100, 'linux', '/opt/chrome'), 'angle-egl');
  assert.equal(glFor({ webgl: true }, 0, 100, 'darwin', null), 'angle');
  assert.equal(glFor({ webgl: [[300, 449]] }, 0, 300, 'linux', '/opt/chrome'), null);
  assert.equal(glFor({ webgl: [[300, 449]] }, 300, 450, 'linux', '/opt/chrome'), 'angle-egl');
  assert.equal(glFor({ webgl: true, chromiumOptions: { gl: 'swangle' } }, 0, 100, 'linux', '/opt/chrome'), 'swangle');
});

test('resolveServeUrl accepts an https URL or a site name, never a path', () => {
  assert.deepEqual(resolveServeUrl('https://example.com/site/index.html'), { serveUrl: 'https://example.com/site/index.html', siteDir: null });
  assert.throws(() => resolveServeUrl('../../etc'));
  assert.throws(() => resolveServeUrl('/etc/passwd'));
});
