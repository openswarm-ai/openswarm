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

## Promote
- [ ] All boxes above ticked.
- [ ] Remove the draft flag (publish the release) — this is the only manual
      promote step; nothing auto-promotes.
- [ ] Confirm `latest.yml` / `latest-mac.yml` are live (HEAD 200) post-publish.

## Rollback (if a regression surfaces post-promote)
- [ ] Re-publish the previous release's feeds as latest, or cut a patch.
- [ ] Tags are immutable (ruleset) — never move `v<version>`; ship a new version.
