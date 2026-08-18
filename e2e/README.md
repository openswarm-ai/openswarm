# End-to-end tests (packaged app, macOS + Windows)

Playwright tests that launch the **packaged** OpenSwarm desktop app (the real
built binary, asar + bundled python-env + real paths) and drive it the way a user
would. The same specs run unchanged on macOS and Windows; CI builds the artifact
per-OS, then runs these. No provider API key is needed (no agent turn), so the
suite is hermetic and deterministic on a clean machine.

## What it checks (per OS)

- Main window paints the React shell (first meaningful paint).
- The preload bridge (`window.openswarm`) is exposed.
- The real backend the app spawned reaches HTTP-ready (`/api/health/check` -> 200).
- Provenance: the running app's `getBuildInfo()` sha matches `electron/build-info.json`.
- App version is reported.

## Run locally

1. Build the app first (produces `electron/dist/...`):
   - Windows: `pwsh scripts/build-app-win.ps1`
   - macOS:   `bash scripts/build-app.sh`
2. Then:
   ```
   cd e2e
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci   # Electron ships its own Chromium
   npm test
   ```

Override the binary location with `E2E_APP_PATH=/path/to/app` if your build
output lives elsewhere. Auto-detection covers `win-unpacked/OpenSwarm.exe` and the
mac `OpenSwarm.app` variants.

## CI

`.github/workflows/e2e.yml` runs this on a `windows-latest` + `macos-latest`
matrix: it builds the unsigned app, then runs the suite. Tag-driven signed
releases are covered separately by `release-windows.yml` / `release-macos.yml`.

## Release characterization (`tests/v1.7-characterization/`)

A regression net for the user-facing claims in the release notes
(`backend/apps/help/changelog.py`, versions 1.7.4-1.7.7). Each test names the
changelog line it pins, so a later refactor of the files that carry that
behaviour (the chat surface, the canvas and window state, the shell's dashboard
host, the layout slice) has to keep the claim true, not just compile. Same rules
as the rest of this suite: packaged app, no provider key, macOS + Windows.

What it drives, and how, without an agent turn:

- **canvas-fullscreen** - the composer yields to open windows; a wheel inside a
  window never moves the canvas; the default wash is flat colour; nothing drags
  while a window is fullscreen and Escape exits; exactly one fullscreen owner,
  ever; dock tiles are images or glyphs, never letters.
- **chat-toolui** - sessions come from the app's own launch route (parked,
  pre-warming); the messages an agent would stream (AskUI approval cards, ShowUI
  links) are dispatched through the store's own reducer in the wire shape the
  backend emits, and the renders and clicks are real. The `respond` call is
  routed so both server verdicts are exercised (accepted -> receipt; gone ->
  the honest "didn't reach the agent" notice). Provider-retry pill survives
  status frames and never shows a scary card.
- **resilience** - a failed or unscoped sessions read never wipes the board;
  then the packaged backend is really killed: a quick recovery is silent, a
  sustained outage shows "Reconnecting to OpenSwarm..." and heals when it can
  (each outage test boots its own app so the respawn budget starts clean).
- **workflows-and-settings** - off means off (Run Now on a switched-off workflow
  is refused and the refusal shows in History; a deleted one cannot run at all);
  a fact saved in Settings -> Memory is the store's own list; the dictation cue
  volume defaults to an audible 70%.

The renderer's store is read and dispatched through `window.__OPENSWARM_STORE__`
(exposed by the packaged renderer under `OPENSWARM_E2E=1`), and the backend is
called from inside the renderer with plain `fetch`, which the app already
bearer-patches, so no spec handles a token or a port by hand.
