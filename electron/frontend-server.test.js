const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createFrontendServer } = require('./frontend-server');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openswarm-frontend-server-'));
  const frontendDir = path.join(root, 'frontend');
  fs.mkdirSync(frontendDir);
  fs.writeFileSync(path.join(frontendDir, 'index.html'), '<main>OpenSwarm</main>');
  fs.writeFileSync(path.join(frontendDir, 'bundle.js'), 'window.ready = true;');
  fs.writeFileSync(path.join(frontendDir, 'module.wasm'), 'wasm');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not public');
  return { root, frontendDir };
}

test('serves packaged assets, MIME types, query strings, and SPA fallback', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const server = createFrontendServer({ frontendDir: files.frontendDir, preferredPort: 0 });
  t.after(() => server.close());
  const port = await server.start();

  assert.deepEqual(await request(port, '/'), {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: '<main>OpenSwarm</main>',
  });
  assert.deepEqual(await request(port, '/bundle.js?v=one'), {
    status: 200,
    type: 'application/javascript; charset=utf-8',
    body: 'window.ready = true;',
  });
  assert.equal((await request(port, '/module.wasm')).type, 'application/wasm');
  assert.equal((await request(port, '/dashboard/client-route')).body, '<main>OpenSwarm</main>');
});

test('denies decoded traversal outside the packaged frontend directory', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const server = createFrontendServer({ frontendDir: files.frontendDir, preferredPort: 0 });
  t.after(() => server.close());
  const port = await server.start();

  const response = await request(port, '/%2e%2e/secret.txt');
  assert.equal(response.status, 403);
  assert.equal(response.body, '');
});

test('falls back to an ephemeral loopback port and closes idempotently', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  const blocker = http.createServer((_req, res) => res.end());
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const occupiedPort = blocker.address().port;
  const server = createFrontendServer({ frontendDir: files.frontendDir, preferredPort: occupiedPort });

  const port = await server.start();
  assert.notEqual(port, occupiedPort);
  assert.equal(server.port, port);
  await server.close();
  await server.close();
  assert.equal(server.port, null);
  await assert.rejects(request(port, '/'), /ECONNREFUSED/);
});

test('rejects and cleans up when preferred and fallback listeners both fail', async () => {
  const servers = [];
  const httpImpl = {
    createServer(handler) {
      const server = new EventEmitter();
      server.handler = handler;
      server.closed = 0;
      server.listen = () => queueMicrotask(() => server.emit('error', new Error('bind denied')));
      server.close = (callback) => { server.closed += 1; callback?.(); };
      server.address = () => null;
      servers.push(server);
      return server;
    },
  };
  const controller = createFrontendServer({
    frontendDir: path.join(os.tmpdir(), 'unused'),
    httpImpl,
  });

  await assert.rejects(controller.start(), /bind denied/);
  assert.equal(servers.length, 2);
  assert.equal(servers.every((server) => server.closed >= 1), true);
  assert.equal(controller.port, null);
});

test('close waits for an in-flight listener and then releases it', async () => {
  let server;
  const httpImpl = {
    createServer(handler) {
      server = new EventEmitter();
      server.handler = handler;
      server.closed = 0;
      server.listen = () => {};
      server.close = (callback) => { server.closed += 1; callback?.(); };
      server.address = () => ({ port: 4173 });
      return server;
    },
  };
  const controller = createFrontendServer({
    frontendDir: path.join(os.tmpdir(), 'unused'),
    httpImpl,
  });

  const starting = controller.start();
  const closing = controller.close();
  assert.equal(server.closed, 0);

  server.emit('listening');
  assert.equal(await starting, 4173);
  await closing;

  assert.equal(server.closed, 1);
  assert.equal(controller.port, null);
});

test('start waits for an overlapping close and creates a fresh listener', async () => {
  const servers = [];
  const httpImpl = {
    createServer(handler) {
      const port = 4173 + servers.length;
      const server = new EventEmitter();
      server.handler = handler;
      server.closed = 0;
      server.listen = () => queueMicrotask(() => server.emit('listening'));
      server.close = (callback) => { server.closed += 1; callback?.(); };
      server.address = () => ({ port });
      servers.push(server);
      return server;
    },
  };
  const controller = createFrontendServer({
    frontendDir: path.join(os.tmpdir(), 'unused'),
    httpImpl,
  });

  assert.equal(await controller.start(), 4173);
  const closing = controller.close();
  const restarting = controller.start();

  await closing;
  assert.equal(await restarting, 4174);
  assert.equal(servers[0].closed, 1);
  assert.equal(servers[1].closed, 0);
  assert.equal(controller.port, 4174);
  await controller.close();
});
