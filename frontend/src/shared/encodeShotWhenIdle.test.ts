import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShotWhenIdle } from './encodeShotWhenIdle';
import { markInteraction } from './interactionPriority';
import type { ElectronNativeImage } from './browserRegistry';

function fakeImage(width: number, log: string[], encoder?: () => string): ElectronNativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height: Math.round(width * 0.6) }),
    resize: (o) => { log.push(`resize:${o.width}`); return fakeImage(o.width ?? width, log, encoder); },
    toDataURL: () => { log.push(`encode:${width}`); return encoder ? encoder() : `data:image/png;base64,${width}`; },
    toPNG: () => Buffer.alloc(0),
    toJPEG: () => Buffer.alloc(0),
  };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DECAY_AND_ONE_WAIT_MS = 350 + 400 + 150;

test('a shot wider than the cap is shrunk before the encode, and never encoded on the caller\'s own frame', async () => {
  const log: string[] = [];
  let out: string | null = null;
  encodeShotWhenIdle(fakeImage(2400, log), 640, (u) => { out = u; });
  assert.equal(out, null);
  assert.deepEqual(log, []);
  await wait(40);
  assert.deepEqual(log, ['resize:640', 'encode:640']);
  assert.equal(out, 'data:image/png;base64,640');
});

test('a shot within the cap encodes as-is', async () => {
  const log: string[] = [];
  let out: string | null = null;
  encodeShotWhenIdle(fakeImage(500, log), 640, (u) => { out = u; });
  await wait(40);
  assert.deepEqual(log, ['encode:500']);
  assert.equal(out, 'data:image/png;base64,500');
});

test('mid-gesture the encode waits for the gesture to end instead of landing on its frames', async () => {
  const log: string[] = [];
  let out: string | null = null;
  markInteraction();
  encodeShotWhenIdle(fakeImage(800, log), 640, (u) => { out = u; });
  await wait(150);
  assert.equal(out, null, 'encoded while the gesture was live');
  assert.deepEqual(log, []);
  await wait(DECAY_AND_ONE_WAIT_MS);
  assert.deepEqual(log, ['resize:640', 'encode:640']);
  assert.equal(out, 'data:image/png;base64,640');
});

test('an encoder that throws reports an empty string rather than killing the caller', async () => {
  const log: string[] = [];
  let out: string | null = null;
  encodeShotWhenIdle(fakeImage(300, log, () => { throw new Error('codec'); }), 640, (u) => { out = u; });
  await wait(40);
  assert.equal(out, '');
});

test('shots that come due together encode one at a time with a breath between, never as one run', async () => {
  const ticks: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < 4; i += 1) {
    const log: string[] = [];
    encodeShotWhenIdle(fakeImage(300 + i, log), 640, () => { ticks.push(Date.now() - t0); });
  }
  await wait(400);
  assert.equal(ticks.length, 4);
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i] - ticks[i - 1] >= 40, `encodes ${i - 1} and ${i} ran ${ticks[i] - ticks[i - 1]} ms apart`);
});
