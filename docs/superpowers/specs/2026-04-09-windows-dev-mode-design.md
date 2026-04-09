# Windows (& Linux) Dev-Mode Support

**Date:** 2026-04-09
**Scope:** Development mode only — no packaged app builds

## Goal

Make OpenSwarm runnable in dev mode on Windows and Linux by replacing the Bash orchestration scripts with cross-platform Node.js equivalents and fixing platform-specific code paths in the Electron main process and Python backend.

## Approach

Add three new `.mjs` scripts that mirror the existing `.sh` scripts but work on all platforms. Existing `.sh` files are untouched — zero risk to current macOS users.

## New Files

### `run.mjs` (root orchestrator)

Replaces `run.sh`. Responsibilities:

- Spawns `node backend/run.mjs` and `node frontend/run.mjs` as child processes
- Prefixes stdout with colored `[backend]` / `[frontend]` / `[electron]` tags using ANSI codes (no dependencies)
- Health-checks `http://localhost:8324` and `http://localhost:3000` via `http.get()` polling
- Once both healthy, launches Electron with `ELECTRON_DEV=1` env var
- Graceful shutdown on SIGINT/SIGTERM: sends SIGTERM on Unix, `taskkill /T /F /PID` on Windows
- Monitors child PIDs — if any exit unexpectedly, tears down all others

### `backend/run.mjs`

Replaces `backend/run.sh`. Responsibilities:

- Creates Python venv if `.venv` doesn't exist: `python -m venv .venv`
- Activates venv by prepending the correct bin dir to PATH (`.venv/Scripts` on Windows, `.venv/bin` on Unix) — no `source activate` needed
- Installs debugger module (`pip install -e .`) if not already installed
- Installs Python dependencies (`pip install -r requirements.txt`)
- Starts uvicorn: `python -m uvicorn backend.main:app --host 0.0.0.0 --port 8324 --reload`

### `frontend/run.mjs`

Replaces `frontend/run.sh`. Responsibilities:

- Runs `npm install` in frontend directory
- Runs `npm run dev`

## Modified Files

### `electron/main.js`

- `getPythonPath()`: Return `.venv\Scripts\python.exe` on `win32`, `.venv/bin/python3` on Unix
- Line 93/98: Change hardcoded `':'` PATH separator to `path.delimiter`
- Line 164: Change `PYTHONPATH` join separator from `':'` to `path.delimiter`

### `backend/apps/tools_lib/tools_lib.py`

- `_extra_bin_dirs()`: On `win32`, return Windows-appropriate paths (`~\AppData\Roaming\npm`, `~\.cargo\bin`, `~\scoop\shims`) instead of Unix-only paths (`/opt/homebrew/bin`, `/usr/local/bin`, etc.)
- `os.chmod(_XBIRD_CONFIG_PATH, 0o600)`: Wrap in `if sys.platform != 'win32'` guard — Windows doesn't support Unix permissions; files are already user-private by default

### `electron/package.json`

- `"dev"` script: Either use `cross-env` for env var setting or rely on `run.mjs` setting `ELECTRON_DEV=1` (making the npm script moot in the cross-platform workflow)
- `"postinstall"`: Guard VMP signing script with platform check so it doesn't fail on Windows/Linux

## Error Handling

- **Python not found**: `backend/run.mjs` checks for `python`/`python3` on PATH at startup, exits with clear error
- **Port conflicts**: Preserved existing behavior — uvicorn/webpack error naturally
- **Windows long paths**: Not expected for dev mode; users can enable `git config --system core.longpaths true` if needed
- **Line endings**: Node.js handles natively — no `sed` stripping needed

## Out of Scope

- Existing `.sh` files (untouched)
- Build/publish scripts (`scripts/build-app.sh`, `scripts/build-python-env.sh`, `publish.sh`)
- Packaged Windows/Linux Electron builds (`.exe`, `.deb`, etc.)
- CI/CD pipeline
- Backend Python application code (already cross-platform except the two fixes above)
- Frontend React code (already platform-agnostic)

## Testing

- Manual testing on Windows, ideally verified on macOS/Linux too
- Verify: venv creation, pip install, uvicorn starts, frontend starts, Electron launches, Ctrl+C clean shutdown
