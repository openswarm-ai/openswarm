#!/bin/bash
# The comment above is shebang, DO NOT REMOVE
#
# Publishes a macOS build to GitHub Releases. Channel is auto-detected from
# the semver string in electron/package.json:
#
#   Stable:       "1.0.37"        -> normal GitHub release
#   Experimental: "1.0.37-exp.1"  -> marked Pre-release on GitHub; only reaches
#                                    users with "Experimental updates" enabled
#                                    in Settings > Advanced.
#
# To promote an experimental release to stable: un-check "This is a pre-release"
# on the GitHub release page (native GitHub UI, no code change needed).
#
# Windows release: tag-triggered via .github/workflows/release-windows.yml,
# which performs the same auto-detection.
PUBLISH_ABSPATH="$(readlink -f "${BASH_SOURCE[0]}")"
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/\r//g' "$PUBLISH_ABSPATH"
else
    sed -i 's/\r//g' "$PUBLISH_ABSPATH"
fi
chmod +x "$PUBLISH_ABSPATH"

PROJECT_ROOT="$(dirname "$PUBLISH_ABSPATH")"
cd "$PROJECT_ROOT"
# Local release credentials (Apple notarization + castlabs EVS/Widevine), gitignored. Sourcing here means a push never stalls on a missing cred once .release.env exists. See .release.env.example.
if [ -f "$PROJECT_ROOT/.release.env" ]; then set -a; . "$PROJECT_ROOT/.release.env"; set +a; echo "==> sourced .release.env"; fi

# electron-builder auto-detects prerelease from semver suffix in electron/package.json
# (e.g. "1.0.37-exp.1" publishes as GitHub Pre-release; "1.0.37" publishes as stable).
# We also export EP_PRE_RELEASE for belt-and-suspenders so the GitHub Releases publisher
# can't accidentally promote an experimental build.
# Experimental builds also default to draft so Eric can sanity-check before flipping the visible toggle.
VERSION="$(node -p "require('./electron/package.json').version")"
if [[ "$VERSION" == *-* ]]; then
    export EP_PRE_RELEASE=true
    export EP_DRAFT=true
    echo "==> Publishing EXPERIMENTAL release: v$VERSION (will be marked Pre-release + Draft on GitHub for manual review)"
else
    echo "==> Publishing STABLE release: v$VERSION"
fi

bash scripts/build-app.sh --publish

# Post-publish belt-and-suspenders: explicitly draft any experimental release in case EP_DRAFT didn't get picked up by electron-builder.
if [[ "$VERSION" == *-* ]]; then
    echo "==> Marking v$VERSION as draft on GitHub..."
    gh release edit "v$VERSION" --draft=true --prerelease 2>/dev/null || echo "WARN: could not mark draft+prerelease via gh CLI (release may not exist yet)"
    # ENG-319 guard: a git tag on origin whose release is a DRAFT poisons releases.atom (the feed
    # lists bare tags), so every experimental updater resolves it first and 404s on its assets.
    # This broke "check for updates" fleet-wide for hours on 2026-08-19. Kill it here, always.
    if git ls-remote --tags origin "refs/tags/v$VERSION" | grep -q .; then
        echo "==> ENG-319 guard: deleting dangling remote tag v$VERSION (release is a draft; a public tag would 404 every experimental updater)"
        git push origin ":refs/tags/v$VERSION" || echo "WARN: could not delete remote tag v$VERSION; DELETE IT MANUALLY or updaters 404"
    fi
fi

cd -
