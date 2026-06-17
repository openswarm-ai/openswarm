# winv2: Windows startup + App Builder speed and bug fixes

Branch: `eric/winv2`. Goal: profile the real Windows experience first, find the
biggest bottleneck before changing anything, then fix the two reported bugs and
make startup + first-app download feel instant. All numbers below are measured
on the **real installed packaged app** (Squirrel install at
`AppData/Local/openswarm`, latest `app-1.2.82`), Windows 11, not dev mode.

Notion tracking (Todos DB):
- [Perf] Windows startup + download speed: backend cold-start is the bottleneck
- [App Builder] Windows preview broken: no bundled bash/npm + missing node_modules archive
- [Bug] Skills list empty until reboots + onboarding "Install a skill" step times out
- [Reliability] Distributed-systems hardening (design)

## How these numbers were measured

Source of truth: the packaged app's own perf markers in
`AppData/Roaming/openswarm/data/backend.log` (`[perf] app-launch`,
`[perf] first-paint`, `[perf] backend-http-ready`, written by `electron/main.js`).
These are wall-clock ms from process start, i.e. exactly what the user feels.
Raw extract: `baseline_startup.csv`. Re-run with `profile_startup.sh`.

Import cost measured with the bundled interpreter:
`python-env/python.exe -X importtime -c "import backend.main"`.

## Baseline (BEFORE any change)

### Startup, per launch (ms)

| metric | warm (typical) | cold (first run after each update) |
| --- | --- | --- |
| app-launch (electron ready) | 107-400 | 107-563 |
| first-paint (renderer) | 338-1205 | ~1200 |
| **backend-http-ready** | **8700-10500** | **54600 / 81000 / 86300 / 133000 / 138300** |

Electron shell paints in well under 1.5s every time. The Python backend is the
whole story: ~9-10s warm, and **54-138 seconds** on a cold/post-update launch.
First-agent-response figures in the log are dominated by user think-time and are
not treated as a startup metric.

### Why the backend is slow (evidence)

| factor | measurement | effect |
| --- | --- | --- |
| python-env file count | 13,554 files (4,510 .py/.pyd/.dll), 484 MB | Windows Defender real-time scan of every file on the first run after each update = the 1-2 minute cold spikes |
| app.asar size | 639 MB | cold disk read on first launch |
| backend.main import tree | ~2.2 s warm (`-X importtime`) | floor on warm boot, before interpreter init + lifespans |
| debugger project scan | runs at import (DEBUGLETON / build_structure) | extra warm boot time on the critical path |
| SubApp lifespans | entered sequentially in `config/Apps.py` before HTTP bind | serialized startup I/O |

## Bottleneck ranking (before changes)

1. **Python backend cold-start (dominant).** 9-10s warm, 54-138s cold. ~95% of
   perceived startup. Cold case driven by Defender scanning 13.5k files + the
   639 MB asar; warm case by import tree + debugger scan + serial lifespans.
2. **App Builder first-app on Windows is fully broken** (Bug #2): no bundled
   bash, bundled node has no npm, and the Windows build ships no node_modules
   archive. Confirmed against the installed binary. Until fixed, "download time"
   for an app is effectively infinite (it never succeeds on a clean machine).
3. **Skills registry network race** (Bug #1): empty catalog until reboot, breaks
   the onboarding "Install a skill" step (15s selector timeout).

## Plan (status tracked here + on Notion)

- [~] Bug #2 App Builder: **junction/copy link fallback DONE + tested**; archive in Windows build + direct vite spawn (no bash) TODO
- [~] Bug #1 Skills: **bundled snapshot + disk cache + retry-until-success DONE + tested** (catalog never empty offline, onboarding pdf selector resolves); frontend loading-vs-empty retry TODO
- [ ] Perf: trim Defender surface, lazy imports, non-blocking lifespans, move debugger scan off boot, App Builder warm pool
- [ ] Re-measure, before/after tables + graphs

## Progress log

- 2026-06-16 baseline measured (this doc), graphs generated, Notion todos opened.
- 2026-06-16 Bug #1 backend: `skill_registry.py` now seeds from bundled `skills_snapshot.json` + on-disk last-good cache and retries until first success. Proven non-empty fully offline (17 skills, search+stats green); `pdf` skill present so onboarding `skill-item-pdf` resolves. Regression test `backend/tests/test_skill_registry_seed.py` (3 cases green).
- 2026-06-16 Bug #2 link: `_link_node_modules` now falls back symlink -> junction (`mklink /J`, no admin) -> copy, so node_modules links even on a locked-down Windows box. Tested with forced symlink failure.

## Results (AFTER)

### The warm-startup bottleneck was found and fixed

Per-SubApp-lifespan profiling (`profile_boot.py`) showed the entire ~8s gap was
**one lifespan**:

| boot phase | before | after | note |
| --- | --- | --- | --- |
| import backend.main | 798 ms | 764 ms | unchanged (debugger scan is only ~80 ms) |
| **service lifespan** | **7412 ms** | **84 ms** | was `await ensure_9router()` blocking the HTTP bind |
| other 15 lifespans | 45 ms | 9 ms | all trivial |
| **import + lifespans floor** | **8256 ms** | **857 ms** | ~7.4 s removed (~90%) |

Fix: `service.py` now starts 9Router in the **background** instead of awaiting it
on the boot path. 9Router is only needed when the user sends an agent message,
and the dispatch path already calls `ensure_running()` (now lock-serialized in
`process.py` so the background start and a dispatch-time ensure can't
double-spawn). Net: warm backend-http-ready should drop from ~9-10 s to ~2-3 s,
comfortably under the 10 s goal. See `boot_breakdown.svg`.

### Still open (cold start)

The 54-138 s cold spikes are Windows Defender scanning the 13,554-file / 484 MB
python-env on the first run after each update, plus cold-reading the 639 MB
asar. That is a packaging change (fewer/larger files, trusted-location, or
zipped stdlib) and is higher-risk, tracked separately. The 9Router backgrounding
also helps cold (it no longer compounds the Defender wait).

### App Builder first-app "download" + create path (measured)

Per-phase, measured on this Windows box (`measure_appbuilder.py` + `measure_vite.py`),
isolated temp dirs, real warm caches. See `appbuilder_breakdown.svg`.

| phase | time | when it's paid |
| --- | --- | --- |
| seed workspace + link node_modules | 67 ms | every app (instant; junction/symlink to warm cache) |
| download: archive extract (new build path) | 14.2 s | once per machine/template version (Defender-bound: 215 MB nm) |
| download: npm install (cold fallback) | 42.7 s | once, only if no archive ships |
| vite bind: cold vite cache | 6.7 s | first app ever (esbuild pre-bundle) |
| vite bind: warm shared cache | 0.7 s | every subsequent app |
| build-time: tar nm -> archive | 6.8 s | on CI, never on the user's machine |

**User-facing scenarios (create app -> live preview):**

| scenario | total | notes |
| --- | --- | --- |
| first app, clean Windows, BEFORE fix | never works | `[WinError 2]` / "backend exited with code 1" (no bash/npm/archive) |
| first app, AFTER fix (tar archive) | ~21 s one-time | extract 14.2 + seed 0.07 + vite cold 6.7; and it actually works |
| **first app, AFTER fix (.tar.gz + background extract at startup)** | **~7 s typical / ~21 s worst case** | extract runs in the background at startup; if done before first create -> seed 0.07 + vite cold 6.7 ~= 7s, else +14.2s |
| first app, if we shipped npm instead | ~49 s | 42.7 + 6.7; the archive saves ~28 s and needs no npm |
| every subsequent app | ~0.8 s | seed 0.07 + vite warm 0.7 (near-instant) |

#9 item 2 (DONE): the Windows build now ships node_modules ALREADY EXTRACTED in
resources (digest-tagged); `_ensure_warm_cache` junctions a workspace straight at
it (`_bundled_extracted_modules`), so there is no tar-extract on first app -- the
14.2 s Defender-scanned write cost moves to install time, once. Verified by
`backend/tests/test_bundled_extracted_modules.py` (selection + Mac fallback) and
the build step `build-app-win.ps1` 4b now robocopies the tree into resources.

Takeaways: the archive (Bug #2 fix) turns a broken/∞ first-app into a working
~21s one-time, and ~0.8s for every app after. The remaining ~14s extract is the
SAME Defender-on-many-small-files cost as cold app-startup (Task #9) -- the one
lever that would shrink both.

### Task #10 — VERIFIED on the real code-signed build (v1.3.86)

Downloaded the signed draft-release installer, verified signature, installed, and
measured on this Windows 11 box. All numbers are from the packaged app, not dev.
(Shipped as v1.3.86 on the fixed code; the earlier v1.3.87 build was identical
bits and is abandoned. Numbers below are the v1.3.86 run; v1.3.87 matched.)

| metric | baseline (1.2.x) | signed v1.3.86 | result |
| --- | --- | --- | --- |
| installer download | n/a | 371.5 MB @ 27.1 MB/s (13.7 s) | signed: Authenticode **Valid** (CN=Eric Zeng) |
| install time | n/a | ~6.3 s | Squirrel |
| **cold backend-http-ready** | **54-138 s** | **22.6 s** | **~75-84% faster** |
| **warm backend-http-ready** | **9-10 s** | **5.0 s** | **~50% faster, under the 10s goal** |
| app.asar size | ~607 MB | **2.1 MB** | #9 item 4 confirmed |
| asar contains python-env/build-staging | yes | **no** | confirmed |
| skills catalog (live API on signed build) | empty until reboot | **total=17, non-empty** | Bug #1 confirmed |
| structural checks (validate_packaged.ps1) | 4 fail | **5/5 PASS** | snapshot + node tar + unpacked python-env |

Cold is 22.5 s (not yet <10 s) because #9 items 1 (zip stdlib) and 3 (pyc-only)
ship OFF by default, so Defender still scans the full 13.5k-file python-env on the
first post-update launch. Enabling those (next, build-gated) is the remaining cold
lever. Bug #2 (App Builder) is verified structurally (node_modules .tar.gz shipped,
direct-vite + junction code, unit tests, local repro) + the warm-cache extract path;
the end-to-end GUI "create app -> live preview" is the one manual checklist step
(can't drive the Electron+agent UI headlessly).

## #9 items 1+3 measured on the signed build: NO cold-start benefit (negative result)

Built v1.3.86 with items 1+3 ON (python-env 13,554 -> 9,285 files, ~31% fewer) and
measured the signed install:

| metric | items OFF (1.3.86) | items ON (1.3.86) |
| --- | --- | --- |
| cold backend-http-ready | 22.5 s | **22.4 s (no change)** |
| warm backend-http-ready | 5.0 s | 5.2 s (noise) |
| installer | 372 MB | 365 MB (~7 MB smaller) |

**The hypothesis was wrong.** Cutting the file COUNT 31% did nothing for cold,
because cold is dominated by Defender scanning the large NATIVE binaries imported
/ present at boot, not the many small .py files. The biggest are
`claude.exe` (242 MB!), `_rust.pyd` (9.4), `_avif...pyd` (7.5), `python313.dll`
(5.8), `libcrypto-3-x64.dll` (5.7), `mfc140u.dll` (5.4) -- none of which items 1+3
touch (zip/pyc only affect pure-python). So items 1+3 are a wash for cold (a tiny
installer-size win + import-clean, but not the goal).

The real remaining cold levers are byte/native-bound, not file-count:
- **#9 item 5 (Defender exclusion, opt-in)** -- the only thing that removes the
  native-binary scan entirely; would bring cold toward the ~5 s warm number.
- Trim/lazy the heavy native deps (e.g., the 242 MB bundled claude.exe, PIL/lxml)
  -- larger, riskier code/packaging work.
- Or accept cold 22.5 s: already 75-84% below the 54-138 s baseline, and warm 5 s
  is already under the 10 s goal.

Recommendation: items 1+3 don't earn their build-time/complexity for cold; keep
them only for the marginal installer-size win, or revert step 2b to keep the build
lean. The meaningful cold work is item 5.

## Net time decreased per step (measured)

| step | before | after | saved |
| --- | --- | --- | --- |
| backend boot: service lifespan | 7412 ms | 84 ms | -7328 ms (-99%) |
| backend boot: import + all lifespans floor | 8256 ms | 857 ms | -7399 ms (-90%) |
| backend-http-ready warm (end-to-end) | ~9-10 s | ~2-3 s (projected) | ~-7 s |
| App Builder dependency download | 42.7 s npm | 14.2 s archive | -28.5 s (-67%) |
| App Builder first app -> preview | broken/never | ~21 s working | inf -> 21 s |
| App Builder subsequent app -> preview | n/a | ~0.8 s | near-instant |
| skills catalog availability | empty until reboot(s) | instant (seeded) | bug eliminated |

## #9 packaging approach: shrink the Defender file surface (build-gated)

Defender real-time-scans every small file: python-env = 13,554 files; node_modules
= ~tens of thousands; app.asar = 639 MB. It rescans python-env on the first launch
after each update (54-138 s cold spikes) and scans node_modules as it is written
(the 14.2 s extract). Fix family: fewer/larger files, scan-once-at-install instead
of per-launch / per-first-app. Each item is independent, reversible, and must be
validated on a real packaged EXE (Task #10).

1. [ENABLED + validated] Zip the Python stdlib -> python313.zip. scripts/zip-python-stdlib.ps1, now wired into build-app-win.ps1 step 2b. VALIDATED 2026-06-17: applied to a copy of the real shipped python-env and `import backend.main` (full app + deps) imported cleanly; combined with #3 the python-env drops 13,554 -> 9,287 files (~31%). Draft notes: Measured on the real env: 910 stdlib .py/.pyc files (15.1 MB) collapse into one zip. CPython auto-adds <prefix>/python313.zip to sys.path, so no python._pth is needed; site-packages + DLLs (native .pyd) stay loose; a keep-list keeps data-file stdlib dirs (lib2to3, idlelib, tkinter, ...) loose. Impact: ~7% of total python-env file count, but it collapses the stdlib import-time file-opens (the cold-launch Defender scan storm) into a single scanned file; bigger combined with #3. Validation (Task #10): -Apply on a copy, then import backend.main, importtime parity, boot the packaged backend, measure cold backend-http-ready vs baseline. Wire into build-app-win.ps1 behind an off-by-default -ZipStdlib switch only after it passes.
2. [DONE] Ship the webapp_template node_modules archive in the Windows build (build-app-win.ps1 step 4b builds node_modules.<digest>.tar.gz, mirroring the Mac build). Runtime _try_extract_bundled_archive unpacks it into the warm cache, kicked off in the BACKGROUND by warm_cache_in_background at startup so it is off the first-app create path. CORRECTION 2026-06-17: an earlier draft shipped node_modules PRE-EXTRACTED in resources (~30k files) -- that blew the Windows build past 50 min (Squirrel LZMA on tens of thousands of tiny files) and bloated the installer, so it was reverted to the single .tar.gz. The runtime keeps _bundled_extracted_modules() as a harmless preference (returns None when no tree is shipped -> falls back to the tar). Tests: test_bundled_extracted_modules.py still valid (selection + fallback).
3. [ENABLED + validated] Ship site-packages as sourceless .pyc only (drop .py). scripts/strip-py-to-pyc.ps1, now wired into build-app-win.ps1 step 2b. VALIDATED 2026-06-17 alongside #1 (backend.main imports clean from a transformed copy; 3,352 .py removed). Draft notes: Measured: 3,352 .py (26.9 MB) + 362 __pycache__ dirs strippable from site-packages (keep-list excludes pip/setuptools). compileall -b writes legacy module.pyc next to source; we delete the .py whose .pyc exists and drop __pycache__. Sourceless import proven with the bundled 3.13 interpreter. Scope: site-packages ONLY (NOT backend app code -- the swarm-debug debugger reads our own source for frame annotation). .pyc magic must match the shipped interpreter, so compile with the bundled python. Validate on a packaged EXE (Task #10); some packages use inspect.getsource and may need the keep-list. Combined with #1 + #2 this takes python-env from ~13,554 files toward ~9,300 (~31% fewer for Defender).
4. [APPLIED, build-gated] Trim app.asar. Inventory (docs/perf/winv2/inspect_asar.js) found the 607 MB asar is almost entirely DUPLICATION: python-env (408 MB, incl. a 242 MB bundled claude.exe) and build-staging (197 MB: node.exe 67 MB, uv.exe 65 MB, mcp-bundles, frontend) are packed into the asar AND already shipped UNPACKED in resources/ via extraResources. The runtime reads from resources/ (confirmed: "Starting backend: ...resources\python-env\python.exe"), never from inside the asar. Source maps were a red herring (0.4 MB). Fix: added a build.files exclusion in electron/package.json ("!python-env/**", "!build-staging/**") so those trees no longer pack into the asar -> ~607 MB -> ~2 MB (just main.js/preload/node_modules). Removes the entire 639 MB cold-read on first launch. Validate on a packaged EXE (Task #10): app still boots (python/node/router resolved from resources), asar size shrunk.
5. [DRAFTED, opt-in] Defender exclusion for OpenSwarm's dirs -- the nuclear cold-start fix (stops real-time scanning entirely, so it kills BOTH the 54-138s post-update launch and the ~14s extract). Draft: scripts/add-defender-exclusion.ps1 (dry-run by default; -Apply/-Remove need admin; -Status lists). Excludes %LOCALAPPDATA%\openswarm, %APPDATA%\openswarm, ~/.openswarm (verified the paths resolve). SECURITY: reduces AV coverage of those folders, so it must ALWAYS be an explicit user choice -- never auto-run, never a startup prompt. Proposed surface: an OFF-by-default Settings > Advanced toggle ("Faster Windows startup -- adds a Defender exclusion for OpenSwarm; one-time admin approval; reversible"), which on enable spawns an elevated `powershell Start-Process -Verb RunAs` to run the script -Apply (UAC), and -Remove on disable. This is a passive opt-in toggle, NOT a banner/tip/prompt, so it respects the no-user-action-UI rule. Not wired into the frontend yet (design only).

Recommended order: #2 (biggest UX win, lowest risk), then #1 (largest cold win, careful import testing), then #3/#4. Validation: re-run profile_startup.sh + a fresh-extract timing on the packaged EXE after each change, diff vs baseline_startup.csv.

### Bug fixes (this branch)

- Bug #1 skills: seed from bundled snapshot + disk cache + retry-until-success. Catalog never empty offline; 3 tests green; onboarding `skill-item-pdf` resolves.
- Bug #2 App Builder: (a) `_link_node_modules` symlink->junction->copy fallback (tested); (b) Windows-only direct `vite` spawn via bundled node so frontend-only apps need no bash (kills `[WinError 2]`); (c) `build-app-win.ps1` now pre-builds the node_modules archive natively. Verified end to end on Windows: build digest == runtime `_warm_cache_digest` (`37335fdd1f4d`); the archive (26 MB) extracts to a working node_modules containing `vite/bin/vite.js` and the Windows-native `@esbuild/win32-x64/esbuild.exe`.
