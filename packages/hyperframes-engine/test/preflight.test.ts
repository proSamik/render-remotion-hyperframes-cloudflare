import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describe, preflight, stripComments } from '../preflight.ts';

function project(html: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  writeFileSync(join(dir, 'index.html'), html);
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
}

test('wall clock, unseeded random and network loads are found, with file and line', () => {
  const dir = project('<html>\n<script src="https://cdn.example.com/lib.js"></script>\n<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">\n<script src="app.js"></script>\n<style>@import url("https://example.com/a.css");</style>\n</html>', {
    'app.js': 'const t0 = performance.now();\nconst when = new Date();\nconst x = Math.random();\nconst y = Date.now();\nconst fixed = new Date(0);\n',
  });
  const found = describe(preflight(dir));
  assert.deepEqual(found.filter((line) => line.startsWith('clock')).map((line) => line.split(' ')[1]), ['app.js:1', 'app.js:2', 'app.js:4']);
  assert.deepEqual(found.filter((line) => line.startsWith('random')).map((line) => line.split(' ')[1]), ['app.js:3']);
  assert.equal(found.filter((line) => line.startsWith('network')).length, 3);
});

test('comments do not count, URLs in code are not comments, vendored libraries are not read', () => {
  const dir = project('<!-- never Date.now() -->\n<script src="assets/vendor/gsap.min.js"></script>\n<script>\n// no Math.random() here\n/* Date.now() */\nconst url = "https://example.com/x"; const seeded = mulberry32(1);\n</script>', {
    'assets/vendor/gsap.min.js': 'Date.now();Math.random();',
    'vendor.lock.json': JSON.stringify({ files: [{ file: 'assets/vendor/gsap.min.js', url: 'https://cdn.example.com/gsap.min.js', sha256: 'x' }] }),
  });
  assert.deepEqual(preflight(dir), []);
});

test('stripComments keeps line numbers', () => {
  assert.equal(stripComments('a\n/* b\nc */\nd // e', false).split('\n').length, 4);
});
