# Release Checklist

Copy this into the release PR/issue and tick every box before promoting a draft
release to `latest`. The goal: no broken build ever reaches users on either
platform. See `RELEASE_RUNBOOK.md` for the how; this is the gate.

## Pre-build
- [ ] `dev` is green and dogfooded; the release commit is chosen.
- [ ] `electron/package.json` `version` bumped per semver (CONTRIBUTING.md).
- [ ] `backend/requirements.lock` regenerated if `requirements.txt` changed, and
      committed alongside it.
- [ ] Both `package-lock.json` files committed (frontend + electron).

## Build (both platforms, same commit)
- [ ] macOS DMG built from the release commit (`bash publish.sh`), signed +
      notarized, both arches (arm64 + x64).
- [ ] Windows EXE built from the same commit (push `v*` tag → CI, or
      `pwsh publish-win.ps1`), signed.
- [ ] Provenance matches: launch each artifact, Settings → About → **Build** sha
      equals `git rev-parse HEAD` of the release commit (and they equal each other).

## Bundle size (cheap, and it has already caught a 175MB regression)
- [ ] `du -sh electron/dist/*/OpenSwarm.app/Contents/Resources/app.asar` is **~2.5MB**.
      Anything above ~10MB means a build artifact got swept in. See "The asar trap" below.
- [ ] Each DMG is within ~10% of the previous release's size (1.7.9: ~300MB).
- [ ] `git status electron/package.json` is clean. electron-builder **rewrites it in place**
      during packaging, leaving a 10-line stub with no `build` section; restore it with
      `git checkout HEAD -- electron/package.json` before any second build.

### The asar trap

**`.gitignore` and `build.files` are two separate exclusion lists, and nothing checks them
against each other.** A file can be invisible to git and still be packed into the app.

Caught 2026-08-24: `electron/whisper/ggml-small.en-q5_1.bin` is a **181MB dictation model
downloaded at runtime into userData** (`electron/voice/whisperModels.js` resolves it from
`userDataDir`; nothing reads it from the bundle). It is gitignored, but `build.files` did not
exclude it, so electron-builder swept it into `app.asar`:

| | app.asar | DMG |
| --- | --- | --- |
| v1.7.9 (published) | 2.5MB | 300MB |
| exp.1 first build | **184MB** | **475MB** |
| exp.1 after the fix | 2.5MB | 309MB |

That is **175MB on every auto-update**, for a file the app never reads.

**Why it stayed hidden:** v1.7.9 was cut in a **detached worktree**, which by definition
contains no gitignored files. So the bug is invisible on a clean cut and fires on any
developer machine that has ever used dictation. A green build on one machine proves nothing
about the next.

Fixed by adding `!whisper` / `!whisper/**` to `build.files`, pinned by
`electron/packaging.test.js`. When adding anything to `.gitignore` that lives under
`electron/`, ask whether `build.files` needs the same entry.

## Artifacts + feeds (promotion gate)
- [ ] GitHub draft release for `v<version>` has: `OpenSwarm-Setup-x64.exe`,
      `OpenSwarm-arm64.dmg`, `OpenSwarm-x64.dmg`, `latest.yml`, `latest-mac.yml`.
- [ ] Promotion gate passes:
      `node scripts/release/verify-release.js --dir <downloaded-feeds> --expect-version <version> --base-url https://github.com/openswarm-ai/openswarm/releases/download/v<version>`
      (both feeds present, versions agree with each other and with package.json,
      every asset HEAD-resolves to 200).

## Dogfood on real target OSes (in production, signed)
- [ ] Windows 11 x64: fresh install of the signed EXE, no SmartScreen block after
      signing, app boots, backend reaches ready, send one agent message (gets a
      response). Check `backend.log` `[provenance]` + `[perf]` lines.
- [ ] Windows 10 x64: same.
- [ ] macOS Apple Silicon (arm64), macOS 12+: fresh DMG install, no Gatekeeper
      block, boots, backend ready, one agent turn.
- [ ] macOS Intel (x64), macOS 12+: same.
- [ ] Auto-update: previous stable installed → this release detected, downloads,
      installs on quit, relaunches on the new version. Verify on both platforms.
- [ ] Widevine DRM: in a Browser card open a Spotify playlist (or any DRM title)
      and confirm a track plays PAST the ~10s encrypted boundary and auto-advances,
      with no `[drm-diag] License response 500` in the logs. A signed-but-not-VMP
      build boots fine and only fails here, so this box catches it. Both platforms.

## Promote
- [ ] All boxes above ticked.
- [ ] Remove the draft flag (publish the release) — this is the only manual
      promote step; nothing auto-promotes.
- [ ] Confirm `latest.yml` / `latest-mac.yml` are live (HEAD 200) post-publish.

## Rollback (if a regression surfaces post-promote)
- [ ] Re-publish the previous release's feeds as latest, or cut a patch.
- [ ] Tags are immutable (ruleset) — never move `v<version>`; ship a new version.
