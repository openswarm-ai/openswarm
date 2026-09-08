import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healTarget } from './modelHealTarget';

const sonnet = { value: 'sonnet-5-cc', label: 'Claude Sonnet 5', billing_kind: 'subscription' };
const haiku = { value: 'haiku', label: 'Claude Haiku 4.5', billing_kind: 'free' };

test('the stored default wins when it is reachable', () => {
  assert.deepEqual(healTarget([sonnet, haiku], 'sonnet-5-cc', { value: 'x', label: 'X' }), { value: 'sonnet-5-cc', label: 'Claude Sonnet 5' });
});

test('otherwise the priority fallback', () => {
  assert.deepEqual(healTarget([sonnet], 'gpt-5.4', { value: 'sonnet-5-cc', label: 'Claude Sonnet 5' }), { value: 'sonnet-5-cc', label: 'Claude Sonnet 5' });
});

test('when only the free row is reachable nothing is moved (the 1.7.9 Haiku rewrite)', () => {
  assert.equal(healTarget([haiku], 'opus-5', { value: 'haiku', label: 'Claude Haiku 4.5' }), null);
  assert.equal(healTarget([], 'opus-5', null), null);
});

test('the per-session heal in Main.tsx decides its target through healTarget', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  const candidates = [here + 'Main.tsx', here.replace(/([\\/])\.test-build([\\/])/, '$1src$2') + 'Main.tsx'];
  const path = candidates.find((p) => fs.existsSync(p));
  assert.ok(path, `could not locate Main.tsx from ${here}`);
  const src = fs.readFileSync(path as string, 'utf8');
  assert.ok(src.includes('healTarget(flat, settings.default_model, fallback)'), 'the heal must ask healTarget, not pick a fallback on its own');
});
