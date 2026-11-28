import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSimpleRequest, toJobRequest } from '../src/api-request.ts';

test('short form for Remotion: composition, props, range, quality, tier', () => {
  const result = toJobRequest({ engine: 'remotion', composition: 'Shapes', inputProps: { title: 'Hi' }, range: [0, 89], quality: '720p', tier: 'fast' }, 4);
  assert.ok('request' in result);
  assert.deepEqual(result.request, { render: { engine: 'remotion', composition: 'Shapes', quality: '720p', inputProps: { title: 'Hi' }, frameRange: [0, 89] }, fleet: { instances: 4 } });
});

test('short form for HyperFrames: project, variables, size and encoder preset, chunks by cost', () => {
  const result = toJobRequest({ engine: 'hyperframes', variables: { title: 'Hi' }, quality: '4k', preset: 'draft', tier: 'economy' }, 4);
  assert.ok('request' in result);
  assert.deepEqual(result.request, { render: { engine: 'hyperframes', project: 'composition', resolution: '2160p', quality: 'draft', variables: { title: 'Hi' } }, fleet: { instances: 1, chunks: 'auto' } });
});

test('defaults: standard tier, composition size, the default composition of the engine', () => {
  const result = toJobRequest({ engine: 'mixed' }, 4);
  assert.ok('request' in result);
  assert.deepEqual(result.request, { render: { engine: 'mixed', composition: 'Mixed', quality: 'composition', inputProps: {} }, fleet: { instances: 2 } });
});

test('the tier never goes above MAX_INSTANCES_PER_RENDER', () => {
  const result = toJobRequest({ engine: 'remotion', tier: 'fast' }, 2);
  assert.ok('request' in result);
  assert.equal(result.request.fleet?.instances, 2);
});

test('refuses what it cannot render', () => {
  const refused = (body: unknown) => 'error' in toJobRequest(body as never, 4);
  assert.ok(refused({ engine: 'lambda' }));
  assert.ok(refused({ engine: 'remotion', composition: '../etc' }));
  assert.ok(refused({ engine: 'remotion', quality: '8k' }));
  assert.ok(refused({ engine: 'remotion', tier: 'ludicrous' }));
  assert.ok(refused({ engine: 'remotion', range: [10, 5] }));
  assert.ok(refused({ engine: 'remotion', range: [0.5, 5] }));
  assert.ok(refused({ engine: 'remotion', inputProps: [1] }));
});

test('the full form is not mistaken for the short one', () => {
  assert.equal(isSimpleRequest({ render: { composition: 'Shapes' } }), false);
  assert.equal(isSimpleRequest({ engine: 'remotion' }), true);
});
