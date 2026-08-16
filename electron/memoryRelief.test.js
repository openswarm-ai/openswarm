// Run: node --test electron/memoryRelief.test.js
//
// ENG-320: memory pressure was detected and only reported; the observed end state is macOS killing
// the app with no trace, once caught live mid-capturePage. These pin the relief contract: enter at
// the cap, act ONCE per episode, gate thumbnails while under pressure, exit below 80% with
// hysteresis so a session hovering at the line cannot thrash caches, and the wire into the sensor
// and capture-page actually exists (an unconsulted flag is the ENG-284 anti-pattern).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const relief = require('./memoryRelief');

test.beforeEach(() => relief.resetMemoryRelief());

test('crossing the cap enters pressure and fires the action set once', () => {
  let cleared = 0;
  relief.initMemoryRelief({ clearCaches: () => { cleared += 1; } });
  assert.equal(relief.updateMemoryPressure(2999, 3000), false);
  assert.equal(relief.underMemoryPressure(), false);
  assert.equal(relief.updateMemoryPressure(3000, 3000), true);
  assert.equal(relief.underMemoryPressure(), true);
  assert.equal(cleared, 1);
  // Staying above the cap must not thrash: one action set per episode.
  relief.updateMemoryPressure(3400, 3000);
  relief.updateMemoryPressure(3600, 3000);
  assert.equal(cleared, 1, 'clearing caches per sample would churn the disk the way ENG-247 did');
});

test('exit needs 80% hysteresis, and a new episode acts again', () => {
  let cleared = 0;
  relief.initMemoryRelief({ clearCaches: () => { cleared += 1; } });
  relief.updateMemoryPressure(3200, 3000);
  assert.equal(relief.updateMemoryPressure(2500, 3000), false, '2500 is above 80% of 3000; still under pressure');
  assert.equal(relief.underMemoryPressure(), true);
  assert.equal(relief.updateMemoryPressure(2300, 3000), true, 'below 2400 clears');
  assert.equal(relief.underMemoryPressure(), false);
  relief.updateMemoryPressure(3100, 3000);
  assert.equal(cleared, 2, 'a genuine second episode earns a second cache clear');
});

test('a throwing action never breaks the sensor path', () => {
  relief.initMemoryRelief({ clearCaches: () => { throw new Error('disk gone'); } });
  assert.doesNotThrow(() => relief.updateMemoryPressure(3200, 3000));
  assert.equal(relief.underMemoryPressure(), true, 'the STATE must flip even when actions fail');
});

test('no actions wired is safe (early boot)', () => {
  assert.doesNotThrow(() => relief.updateMemoryPressure(9000, 3000));
  assert.equal(relief.underMemoryPressure(), true);
});

test('the sensor feeds it and capture-page consults it', () => {
  const sensor = fs.readFileSync(path.join(__dirname, 'memorySensor.js'), 'utf8');
  assert.match(sensor, /updateMemoryPressure\(mb, TOTAL_MB_CAP\)/, 'unwired relief is telemetry with extra steps');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('capture-page'");
  const beforeComposite = main.slice(start, main.indexOf('capturePage(', start));
  assert.match(beforeComposite, /underMemoryPressure\(\)\) return null/, 'the gate must run BEFORE the composite, the observed death site');
  assert.match(main, /initMemoryRelief\(/, 'actions must be wired at boot');
});
