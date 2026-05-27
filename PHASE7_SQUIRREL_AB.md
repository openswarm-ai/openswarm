# Phase 7: Squirrel vs NSIS A/B

NSIS is the shipped Windows installer and **stays the default**. Squirrel is a
candidate only — it wins, and replaces NSIS, **only if** it is measurably faster
*and* its auto-update rollback works on real Win 10/11 machines. Otherwise NSIS
stays. This doc is the procedure to make that call with data, not vibes.

## Build both from the same commit

```powershell
# NSIS (default, what ships today)
pwsh scripts\build-app-win.ps1 -Sign        # -> electron\dist\OpenSwarm-Setup-x64.exe

# Squirrel (candidate), same staged tree / same SHA
pwsh scripts\build-app-win.ps1 -Sign -Squirrel
```

The `-Squirrel` switch only overrides `win.target` (via
`--config.win.target=squirrel`); signing, extraResources, and the bundled
python/node/router are identical, so any measured difference is the installer
itself, not the payload. Confirm both report the same provenance sha (Settings
-> About -> Build, or the `[provenance]` line in backend.log).

## Measure on REAL Windows 10 and 11 (x64), clean machines

For each installer, on a fresh VM/box (no prior OpenSwarm install):

| Metric | How |
|---|---|
| Install time | wall-clock from launching the installer to the app window appearing |
| First paint | `[perf] first-paint` in backend.log (`scripts/perf/parse-timing.js`) |
| Backend ready | `[perf] backend-http-ready` |
| Crashes | any crash on first launch; check `%APPDATA%\OpenSwarm\Crashpad` |
| Auto-update | install an older build, then this one; confirm it detects, downloads, installs on quit, relaunches on the new version |
| Rollback | after an update, force a downgrade/rollback path; confirm the previous version comes back cleanly and the feed isn't corrupted |

Run each 3x per OS and take the median. Compare against the Phase 0 baseline
(file count 11,247 / 1.2 GB) and NSIS's own numbers.

## Decision gate

- Squirrel **wins** only if: median install + first-paint + backend-ready are
  faster than NSIS on BOTH Win 10 and Win 11, AND auto-update works, AND rollback
  works (including rebuilding whatever feed Squirrel's differential updates need).
- Any of those fail -> **NSIS stays**, revert the target, keep `-Squirrel` as a
  dead experiment flag or remove it.

## Why this is the last phase

Squirrel changes the update feed format and rollback semantics. Switching it in
without the rollback feed rebuilt strands users on a broken updater — the exact
failure the rest of this plan exists to prevent. So it goes last, behind a flag,
and only on proof.
