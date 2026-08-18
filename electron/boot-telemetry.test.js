const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBootTelemetry } = require('./boot-telemetry');

function harness(overrides = {}) {
  const logs = [];
  const scheduled = [];
  const beacons = [];
  const telemetry = createBootTelemetry({
    launchTime: 1_000,
    now: () => 1_125,
    logger: { log: (message) => logs.push(message) },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
    onBeaconReady: () => beacons.push('ready'),
    ...overrides,
  });
  return { telemetry, logs, scheduled, beacons };
}

test('records each performance milestone once from process launch', () => {
  let now = 1_125;
  const fixture = harness({ now: () => now });

  assert.equal(fixture.telemetry.markPerformance('first-paint'), true);
  now = 1_900;
  assert.equal(fixture.telemetry.markPerformance('first-paint'), false);
  fixture.telemetry.markPerformance('first-agent-response');

  assert.deepEqual(fixture.telemetry.beaconSnapshot().perf, {
    'first-paint': 125,
    'first-agent-response': 900,
  });
  assert.deepEqual(fixture.logs, [
    '[perf] first-paint t=125',
    '[perf] first-agent-response t=900',
  ]);
});

test('keeps only the newest bounded backend diagnostics for splash callbacks', () => {
  const fixture = harness({ stderrLimit: 3 });
  fixture.telemetry.appendBackendStderr('one');
  fixture.telemetry.appendBackendStderr('two');
  fixture.telemetry.appendBackendStderr('three');
  fixture.telemetry.appendBackendStderr('four');

  assert.equal(fixture.telemetry.recentBackendStderr(2), 'threefour');
  assert.equal(fixture.telemetry.recentBackendStderr(30), 'two three four'.replaceAll(' ', ''));
});

test('projects preflight state into the existing compact beacon shape', () => {
  const fixture = harness();
  fixture.telemetry.setPreflightInfo({ userDataWritable: true, freeDiskMB: 2048 });
  fixture.telemetry.setPreflightVerdict({
    verdict: 'warn',
    totalMs: 44,
    results: [
      { name: 'disk', status: 'ok', reason: '' },
      { name: 'gpu', status: 'warn', reason: 'slow' },
    ],
  });

  assert.deepEqual(fixture.telemetry.beaconSnapshot(), {
    perf: {},
    preflight: { userDataWritable: true, freeDiskMB: 2048 },
    preflight2: {
      verdict: 'warn',
      totalMs: 44,
      names: ['disk:ok', 'gpu:warn'],
    },
  });
});

test('commits a staged preflight cache only after backend readiness and only once', () => {
  const fixture = harness();
  const writes = [];
  const pf = {
    defaultEnv: () => ({ platform: 'win32' }),
    writeCache: (...args) => writes.push(args),
  };
  const result = { verdict: 'ok', totalMs: 25, results: [] };

  fixture.telemetry.stagePreflightCache({ pf, dataDir: 'C:/data', version: '1.2.3', result });
  assert.deepEqual(writes, []);
  fixture.telemetry.markPerformance('backend-http-ready');
  fixture.telemetry.commitPreflightCacheIfReady();
  fixture.telemetry.commitPreflightCacheIfReady();

  assert.deepEqual(writes, [[{ platform: 'win32' }, 'C:/data', '1.2.3', result]]);
  assert.equal(fixture.logs.at(-1), '[preflight2] cache committed for v1.2.3');
});

test('a cache staged after readiness commits immediately and consumes failures', () => {
  const fixture = harness();
  fixture.telemetry.markPerformance('backend-http-ready');
  let attempts = 0;
  const pf = {
    defaultEnv: () => ({}),
    writeCache: () => { attempts += 1; throw new Error('denied'); },
  };

  fixture.telemetry.stagePreflightCache({
    pf,
    dataDir: '/data',
    version: '2.0.0',
    result: { verdict: 'ok' },
  });
  fixture.telemetry.commitPreflightCacheIfReady();

  assert.equal(attempts, 1);
  assert.equal(fixture.logs.at(-1), '[preflight2] cache write failed: denied');
});

test('schedules one delayed beacon only after paint and backend are both ready', () => {
  const fixture = harness();
  fixture.telemetry.markPerformance('first-paint');
  assert.equal(fixture.telemetry.scheduleBeaconIfReady(), false);
  fixture.telemetry.markPerformance('backend-http-ready');
  assert.equal(fixture.telemetry.scheduleBeaconIfReady(), true);
  assert.equal(fixture.telemetry.scheduleBeaconIfReady(), false);

  assert.equal(fixture.scheduled.length, 1);
  assert.equal(fixture.scheduled[0].delay, 1500);
  assert.deepEqual(fixture.beacons, []);
  fixture.scheduled[0].callback();
  assert.deepEqual(fixture.beacons, ['ready']);
});

test('beacon callback reads telemetry at send time rather than schedule time', () => {
  const snapshots = [];
  let telemetry;
  const fixture = harness({ onBeaconReady: () => snapshots.push(telemetry.beaconSnapshot()) });
  telemetry = fixture.telemetry;
  telemetry.markPerformance('first-paint');
  telemetry.markPerformance('backend-http-ready');
  telemetry.scheduleBeaconIfReady();
  telemetry.markPerformance('first-agent-response');
  fixture.scheduled[0].callback();

  assert.equal(snapshots[0].perf['first-agent-response'], 125);
});
