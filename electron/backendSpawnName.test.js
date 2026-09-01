// The packaged backend's command line must not look like the app an agent is building. Agents restart
// their FastAPI dev servers with `pkill -f "uvicorn backend.main"` (the app template is uvicorn +
// backend/main.py), and on 2026-09-01 that command, run by ONE agent, SIGTERMed the host backend, a
// second instance's backend and the user's production app backend, twice. Sessions mid-turn were
// flushed as "stopped" with nothing saying why: silent work loss caused by a name collision.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function backendSpawnArgs() {
  const m = SRC.match(/backendProcess = spawn\(\s*pythonPath,\s*\[([^\]]*)\]/);
  assert.ok(m, 'the backend spawn call must be findable');
  return m[1];
}

test('the backend runs as backend.serve, never as the uvicorn CLI on backend.main', () => {
  const args = backendSpawnArgs();
  assert.match(args, /'-m',\s*'backend\.serve'/);
  assert.doesNotMatch(args, /uvicorn/, 'an agent pkill -f uvicorn would catch the host backend');
  assert.doesNotMatch(args, /backend\.main/, 'an agent pkill -f backend.main would catch the host backend');
});

test('backend/serve.py exists and is the only module spelled in the spawn', () => {
  const serve = fs.readFileSync(path.join(__dirname, '..', 'backend', 'serve.py'), 'utf8');
  assert.match(serve, /uvicorn\.Config\("backend\.main:app"/, 'serve.py hands the app to uvicorn programmatically, keeping the name off argv');
  assert.match(serve, /READY:PORT=/, 'the readiness line the shell may wait on');
});
