// Prefer the conventional port, then let get-port fall back to an OS-assigned
// port. Passing one preferred number is important: get-port already appends
// port 0, while a 101-port range can turn endpoint-security bind inspection
// into a long serial startup delay. The renderer reads the selected port via
// IPC, so no fallback range is required.
async function pickBackendPort(options = {}) {
  const getPortImpl = options.getPortImpl || require('get-port');

  // host:'127.0.0.1' is load-bearing. The backend binds uvicorn --host
  // 127.0.0.1, but get-port defaults to probing 0.0.0.0, and on Windows a
  // 0.0.0.0:PORT probe SUCCEEDS even when another process already holds
  // 127.0.0.1:PORT (loopback). So without this, get-port hands back e.g.
  // 8324 as "free" while something else owns 127.0.0.1:8324, the backend
  // then fails its 127.0.0.1 bind with WinError 10048 and exits, and the
  // app shows "backend crashed". Probing the same interface uvicorn binds
  // makes get-port skip the occupied port. (POSIX already rejects the
  // mismatched 0.0.0.0 probe, so this is a no-op correctness win on Mac.)
  return getPortImpl({
    port: 8324,
    host: '127.0.0.1',
  });
}

module.exports = {
  pickBackendPort,
};
