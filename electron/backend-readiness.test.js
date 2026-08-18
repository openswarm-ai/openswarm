const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  authTokenFilePath,
  createBackendImportWarmup,
  loadAuthToken,
  readAuthToken,
  waitForBackend,
} = require('./backend-readiness');

test('backend import warmup is isolated from user data and inherited Python paths', () => {
  const spec = createBackendImportWarmup({
    pythonPath: 'C:\\app\\resources\\python-env\\python.exe',
    projectRoot: 'C:\\app\\resources',
    debuggerDir: 'C:\\app\\resources\\debugger',
    pythonSitePackages: 'C:\\app\\resources\\python-env\\Lib\\site-packages',
    scratchRoot: 'C:\\temp\\openswarm-warmup',
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      ENABLE_HOSTED_DEMO: '1',
      PYTHONHOME: 'C:\\host\\python',
      PYTHONPATH: 'C:\\host\\untrusted',
    },
    pathImpl: path.win32,
  });

  assert.equal(spec.file, 'C:\\app\\resources\\python-env\\python.exe');
  assert.deepEqual(spec.args, ['-s', '-c', 'import backend.main; print("backend.main importable")']);
  assert.equal(spec.options.cwd, 'C:\\app\\resources');
  assert.equal(spec.options.env.APPDATA, 'C:\\temp\\openswarm-warmup');
  assert.equal(spec.options.env.LOCALAPPDATA, 'C:\\temp\\openswarm-warmup');
  assert.equal(spec.options.env.HOME, 'C:\\temp\\openswarm-warmup');
  assert.equal(spec.options.env.USERPROFILE, 'C:\\temp\\openswarm-warmup');
  assert.equal(spec.options.env.XDG_DATA_HOME, 'C:\\temp\\openswarm-warmup');
  assert.equal(spec.options.env.OPENSWARM_PACKAGED, '1');
  assert.equal(spec.options.env.OPENSWARM_BACKEND_IMPORT_ONLY, '1');
  assert.equal(spec.options.env.ENABLE_HOSTED_DEMO, '0');
  assert.equal(spec.options.env.OPENSWARM_DISABLE_9ROUTER_AUTOSTART, '1');
  assert.equal(spec.options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(spec.options.env.PYTHONNOUSERSITE, '1');
  assert.equal(
    spec.options.env.PYTHONPATH,
    [
      'C:\\app\\resources',
      'C:\\app\\resources\\debugger',
      'C:\\app\\resources\\python-env\\Lib\\site-packages',
    ].join(path.win32.delimiter),
  );
  assert.ok(!spec.options.env.PYTHONPATH.includes('untrusted'));
  assert.equal('PYTHONHOME' in spec.options.env, false);
});

test('backend import warmup redirects macOS and Linux data roots', () => {
  const common = {
    pythonPath: '/app/resources/python-env/bin/python3',
    projectRoot: '/app/resources',
    scratchRoot: '/tmp/openswarm-warmup',
    env: { HOME: '/Users/ada', XDG_DATA_HOME: '/home/ada/.local/share' },
    pathImpl: path.posix,
  };
  const mac = createBackendImportWarmup({ ...common, platform: 'darwin' });
  const linux = createBackendImportWarmup({ ...common, platform: 'linux' });
  assert.equal(mac.options.env.HOME, '/tmp/openswarm-warmup');
  assert.equal(linux.options.env.XDG_DATA_HOME, '/tmp/openswarm-warmup');
  assert.equal(mac.options.env.APPDATA, '/tmp/openswarm-warmup');
  assert.equal(linux.options.env.USERPROFILE, '/tmp/openswarm-warmup');
});

test('backend import warmup rejects incomplete path contracts', () => {
  assert.throws(
    () => createBackendImportWarmup({ pythonPath: 'python', projectRoot: '/app' }),
    /requires pythonPath, projectRoot, scratchRoot, and platform/,
  );
});

function tokenPath(overrides = {}) {
  return authTokenFilePath({
    isPackaged: true,
    platform: 'linux',
    env: {},
    homedir: () => '/home/ada',
    electronDir: '/repo/electron',
    pathImpl: path.posix,
    ...overrides,
  });
}

test('resolves auth.token for dev and every packaged data-root policy', () => {
  assert.equal(tokenPath({ isPackaged: false }), '/repo/backend/data/auth.token');
  assert.equal(
    tokenPath({ platform: 'darwin', homedir: () => '/Users/ada' }),
    '/Users/ada/Library/Application Support/OpenSwarm/data/auth.token',
  );
  assert.equal(
    tokenPath({ platform: 'win32', env: { APPDATA: '/profiles/ada/roaming' } }),
    '/profiles/ada/roaming/OpenSwarm/data/auth.token',
  );
  assert.equal(
    tokenPath({ platform: 'win32', homedir: () => '/Users/ada' }),
    '/Users/ada/OpenSwarm/data/auth.token',
  );
  assert.equal(
    tokenPath({ env: { XDG_DATA_HOME: '/data/ada' } }),
    '/data/ada/OpenSwarm/data/auth.token',
  );
  assert.equal(tokenPath(), '/home/ada/.local/share/OpenSwarm/data/auth.token');
});

test('reads and trims a token, returning empty on blank or failed reads', () => {
  assert.equal(readAuthToken('/token', { readFileSync: () => '  secret\n' }), 'secret');
  assert.equal(readAuthToken('/token', { readFileSync: () => '  \n' }), '');
  assert.equal(readAuthToken('/token', { readFileSync: () => { throw new Error('missing'); } }), '');
});

test('token loading preserves retry cadence and success logging', async () => {
  let reads = 0;
  const sleeps = [];
  const logs = [];
  const warnings = [];
  const token = await loadAuthToken({
    tokenPath: '/data/auth.token',
    fsImpl: { readFileSync: () => (++reads === 3 ? ' live-token ' : '') },
    sleep: async (ms) => { sleeps.push(ms); },
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
  });

  assert.equal(token, 'live-token');
  assert.equal(reads, 3);
  assert.deepEqual(sleeps, [100, 100]);
  assert.deepEqual(logs, ['[auth] loaded token from /data/auth.token']);
  assert.deepEqual(warnings, []);
});

test('token loading performs all 20 reads and final sleeps before warning', async () => {
  let reads = 0;
  const sleeps = [];
  const warnings = [];
  const token = await loadAuthToken({
    tokenPath: '/data/auth.token',
    fsImpl: { readFileSync: () => { reads += 1; throw new Error('not ready'); } },
    sleep: async (ms) => { sleeps.push(ms); },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(token, '');
  assert.equal(reads, 20);
  assert.equal(sleeps.length, 20);
  assert.equal(sleeps.every((ms) => ms === 100), true);
  assert.deepEqual(warnings, [
    '[auth] FAILED to load auth token from /data/auth.token after 2s — WS/HTTP will be rejected',
  ]);
});

function requestDouble(onGet) {
  return {
    get(url, callback) {
      const request = new EventEmitter();
      request.destroyed = false;
      request.setTimeout = (ms, handler) => {
        request.timeoutMs = ms;
        request.timeoutHandler = handler;
      };
      request.destroy = () => { request.destroyed = true; };
      onGet({ url, callback, request });
      return request;
    },
  };
}

test('health polling resolves only on HTTP 200 and retries other statuses after 500ms', async () => {
  const statuses = [503, 200];
  const delays = [];
  const urls = [];
  const result = waitForBackend(8330, {
    httpImpl: requestDouble(({ url, callback }) => {
      urls.push(url);
      queueMicrotask(() => callback({ statusCode: statuses.shift() }));
    }),
    setTimeoutImpl(handler, ms) {
      delays.push(ms);
      queueMicrotask(handler);
    },
  });

  await result;
  assert.deepEqual(urls, [
    'http://127.0.0.1:8330/api/health/check',
    'http://127.0.0.1:8330/api/health/check',
  ]);
  assert.deepEqual(delays, [500]);
});

test('health polling rejects nonzero exits and spawn errors but ignores clean exits', async () => {
  const stalledHttp = requestDouble(() => {});
  const failed = new EventEmitter();
  const failedWait = waitForBackend(8330, { process: failed, httpImpl: stalledHttp });
  failed.emit('exit', 7);
  await assert.rejects(failedWait, /Backend process exited with code 7 during startup/);

  const spawnFailed = new EventEmitter();
  const spawnWait = waitForBackend(8330, { process: spawnFailed, httpImpl: stalledHttp });
  spawnFailed.emit('error', new Error('blocked'));
  await assert.rejects(spawnWait, /Backend failed to spawn: blocked/);

  const clean = new EventEmitter();
  const cleanWait = waitForBackend(8330, {
    process: clean,
    httpImpl: requestDouble(({ callback }) => queueMicrotask(() => callback({ statusCode: 200 }))),
  });
  clean.emit('exit', 0);
  await cleanWait;
});

test('health polling preserves warning thresholds and request timeout behavior', async () => {
  const nowValues = [0, 60_001, 180_001, 180_500];
  const statuses = [503, 503, 200];
  const stillStarting = [];
  const takingTooLong = [];
  const delays = [];
  const requests = [];
  const waiting = waitForBackend(8330, {
    now: () => nowValues.shift(),
    onStillStarting: () => stillStarting.push('shown'),
    onTakingTooLong: () => takingTooLong.push('shown'),
    httpImpl: requestDouble(({ callback, request }) => {
      requests.push(request);
      queueMicrotask(() => callback({ statusCode: statuses.shift() }));
    }),
    setTimeoutImpl(handler, ms) {
      delays.push(ms);
      queueMicrotask(handler);
    },
  });

  await waiting;
  assert.deepEqual(stillStarting, ['shown']);
  assert.deepEqual(takingTooLong, ['shown']);
  assert.deepEqual(delays, [500, 500]);
  assert.equal(requests.every((request) => request.timeoutMs === 2000), true);

  const timeoutDelays = [];
  let timedRequest;
  const timeoutWait = waitForBackend(8331, {
    httpImpl: requestDouble(({ callback, request }) => {
      timedRequest = request;
      request.afterTimeout = () => callback({ statusCode: 200 });
    }),
    setTimeoutImpl(handler, ms) {
      timeoutDelays.push(ms);
      if (ms === 500) queueMicrotask(() => timedRequest.afterTimeout());
    },
  });
  timedRequest.timeoutHandler();
  await timeoutWait;
  assert.equal(timedRequest.destroyed, true);
  assert.equal(timedRequest.timeoutMs, 2000);
  assert.deepEqual(timeoutDelays, [500]);
});
