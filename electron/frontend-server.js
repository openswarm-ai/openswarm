const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const FRONTEND_HOST = '127.0.0.1';
const PREFERRED_FRONTEND_PORT = 4173;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

function createRequestHandler(options) {
  const {
    frontendDir,
    fsImpl = fs,
    pathImpl = path,
    logger = console,
  } = options;
  const root = pathImpl.resolve(frontendDir);
  const indexPath = pathImpl.join(root, 'index.html');

  return (req, res) => {
    try {
      let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (pathname === '/' || pathname === '') pathname = '/index.html';
      const resolved = pathImpl.normalize(pathImpl.join(root, pathname));
      if (!resolved.startsWith(root + pathImpl.sep) && resolved !== indexPath) {
        res.writeHead(403);
        res.end();
        return;
      }
      fsImpl.readFile(resolved, (error, data) => {
        if (error) {
          fsImpl.readFile(indexPath, (indexError, indexData) => {
            if (indexError) {
              res.writeHead(404);
              res.end();
              return;
            }
            res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
            res.end(indexData);
          });
          return;
        }
        const extension = pathImpl.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream' });
        res.end(data);
      });
    } catch (error) {
      logger.error('[frontend-server] request handler threw:', error && error.message);
      try {
        res.writeHead(500);
        res.end();
      } catch {}
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function logRuntimeErrors(server, logger) {
  server.on('error', (error) => {
    logger.error('[frontend-server] listener failed:', error && error.message);
  });
}

function createFrontendServer(options) {
  const {
    frontendDir,
    httpImpl = http,
    host = FRONTEND_HOST,
    preferredPort = PREFERRED_FRONTEND_PORT,
    logger = console,
  } = options;
  const handler = createRequestHandler({ ...options, frontendDir, logger });
  let activeServer = null;
  let activePort = null;
  let startPromise = null;
  let closePromise = null;

  async function startFresh() {
    const preferred = httpImpl.createServer(handler);
    try {
      activePort = await listen(preferred, preferredPort, host);
      activeServer = preferred;
      logRuntimeErrors(preferred, logger);
      logger.log(`[frontend-server] listening on ${host}:${activePort}`);
      return activePort;
    } catch {
      await closeServer(preferred);
    }

    const fallback = httpImpl.createServer(handler);
    try {
      activePort = await listen(fallback, 0, host);
      activeServer = fallback;
      logRuntimeErrors(fallback, logger);
      logger.log(`[frontend-server] listening (fallback) on ${host}:${activePort}`);
      return activePort;
    } catch (error) {
      logger.error('[frontend-server] fallback also failed:', error && error.message);
      await closeServer(fallback);
      activePort = null;
      throw error;
    }
  }

  return {
    get port() { return activePort; },
    async start() {
      if (closePromise) await closePromise;
      if (activeServer) return activePort;
      if (!startPromise) startPromise = startFresh();
      try {
        return await startPromise;
      } finally {
        if (!activeServer) startPromise = null;
      }
    },
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          const pendingStart = startPromise;
          if (pendingStart) {
            try {
              await pendingStart;
            } catch {}
          }
          const server = activeServer;
          activeServer = null;
          activePort = null;
          startPromise = null;
          await closeServer(server);
        })();
      }
      try {
        await closePromise;
      } finally {
        closePromise = null;
      }
    },
  };
}

module.exports = {
  FRONTEND_HOST,
  PREFERRED_FRONTEND_PORT,
  MIME_TYPES,
  createRequestHandler,
  createFrontendServer,
};
