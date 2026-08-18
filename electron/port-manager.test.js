const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickBackendPort } = require('./port-manager');

function fakePortFinder(implementation, makeRange = () => {
  throw new Error('makeRange must not be called');
}) {
  const calls = [];
  const finder = async (options) => {
    calls.push(options);
    return implementation(options, calls.length);
  };
  finder.makeRange = makeRange;
  return { finder, calls };
}

test('asks get-port once for the preferred port on the backend loopback host', async () => {
  const { finder, calls } = fakePortFinder(async () => 8324);
  const port = await pickBackendPort({ getPortImpl: finder });

  assert.equal(port, 8324);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { port: 8324, host: '127.0.0.1' });
});

test('lets get-port resolve its own fallback without making a second call', async () => {
  const { finder, calls } = fakePortFinder(() => new Promise((resolve) => {
    setTimeout(() => resolve(49152), 10);
  }), () => 8324);

  const port = await pickBackendPort({
    getPortImpl: finder,
    timeoutMs: 1,
  });

  assert.equal(port, 49152);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { port: 8324, host: '127.0.0.1' });
});

test('always probes the loopback host used by the backend', async () => {
  const { finder, calls } = fakePortFinder(async () => 8324, () => 8324);
  const port = await pickBackendPort({
    getPortImpl: finder,
    host: '0.0.0.0',
  });

  assert.equal(port, 8324);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { port: 8324, host: '127.0.0.1' });
});
