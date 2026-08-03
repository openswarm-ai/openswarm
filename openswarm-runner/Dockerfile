# syntax=docker/dockerfile:1
#
# One OpenSwarm workflow run, then exit. Build context is the REPO ROOT, not this
# directory, because the image needs backend/ and requirements.lock:
#
#   docker build --platform linux/amd64 -f openswarm-runner/Dockerfile -t openswarm-runner .
#
# Layout the image commits to (all three are load-bearing, backend code resolves
# them with zero changes when OPENSWARM_PACKAGED=1):
#   /app/backend      the FastAPI orchestrator
#   /app/router       9router's standalone server, found by p_find_9router_dir()
#   /app/python-env   UV_PYTHON target probed by tools_lib/mcp_config.py
#
# Plus the renderer half, which exists so browser tools work the way they do on a
# laptop instead of being denied:
#   /app/electron-runtime   the same CastLabs Electron build the desktop app ships
#   /app/electron           the desktop shell's own main process, unmodified
#   /app/frontend           the production webpack bundle, served off loopback
#
# amd64 only. CastLabs publishes no linux-arm64 build, and running a DIFFERENT
# Electron than the desktop app ships would quietly undo the point of this image.

ARG PYTHON_VERSION=3.13
ARG NODE_VERSION=20
ARG ROUTER_VERSION=0.3.60
ARG UV_VERSION=0.11.8
# Must track electron/package.json's devDependency, or the container drives a different browser than the laptop does.
ARG ELECTRON_VERSION=42.3.3+wvcus
ARG ELECTRON_SHA256=5b6ce3a4d13f07fc63d79e884f6a40d1bc8a1cdf82cb2d130c26e8c1530649cb

FROM node:${NODE_VERSION}-bookworm-slim AS node

# 9router 0.3.60 is pure JavaScript; --ignore-scripts skips a postinstall that only rebuilds a native addon the standalone server never loads.
FROM node AS router
ARG ROUTER_VERSION
WORKDIR /stage
RUN printf '{"name":"router-stage","version":"0.0.0","private":true}\n' > package.json \
 && npm install "9router@${ROUTER_VERSION}" --no-save --no-audit --no-fund --silent --ignore-scripts \
 && test -f node_modules/9router/app/server.js \
 && test -z "$(find node_modules/9router -name '*.node' -print -quit)"

# The App Builder's template dependencies, installed once here and shipped ALREADY EXTRACTED at
# the digest path backend/apps/outputs/view_builder_templates.py already probes. Without it the
# first CreateApp in a run pays a cold npm install against the public registry, and a run with no
# egress just fails. NOT $BUILDPLATFORM: vite pulls in a platform-specific esbuild, so this has to
# resolve on the arch the container will actually run on.
FROM node:${NODE_VERSION}-bookworm-slim AS webapp-template
WORKDIR /stage
COPY backend/apps/outputs/webapp_template/frontend/package.json ./package.json
RUN set -eux; \
    npm install --no-audit --no-fund --loglevel=error --ignore-scripts; \
    test -x node_modules/.bin/vite; \
    digest="$(sha256sum package.json | cut -c1-12)"; \
    mkdir -p "/out/${digest}"; \
    mv node_modules "/out/${digest}/node_modules"

# Webpack output is architecture-independent, so this runs natively on the build host rather than under emulation.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund --silent
COPY frontend ./
RUN npm run build && test -f dist/index.html

# The shell's runtime deps only. --ignore-scripts leaves uiohook-napi without its prebuilt addon, which is correct: it taps a real keyboard, there isn't one here, and voiceHotkey already requires it inside a try.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS shell-deps
WORKDIR /stage
COPY electron/package.json electron/package-lock.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent

FROM debian:bookworm-slim AS electron
ARG ELECTRON_VERSION
ARG ELECTRON_SHA256
ARG TARGETARCH
RUN set -eux; \
    test "${TARGETARCH}" = "amd64" || { echo "the renderer half is amd64-only: CastLabs ships no linux-${TARGETARCH} Electron" >&2; exit 1; }; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip; \
    url="https://github.com/castlabs/electron-releases/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"; \
    curl -fsSL -o /tmp/electron.zip "${url}"; \
    echo "${ELECTRON_SHA256}  /tmp/electron.zip" | sha256sum -c -; \
    mkdir -p /stage; \
    unzip -q /tmp/electron.zip -d /stage; \
    rm /tmp/electron.zip; \
    test -x /stage/electron

FROM python:${PYTHON_VERSION}-slim-bookworm AS uv
ARG UV_VERSION
ARG TARGETARCH
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    case "${TARGETARCH}" in \
      amd64) triple=x86_64-unknown-linux-gnu; sha=56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sha=eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591 ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz"; \
    echo "${sha}  /tmp/uv.tar.gz" | sha256sum -c -; \
    mkdir -p /stage; \
    tar -xzf /tmp/uv.tar.gz -C /stage --strip-components=1

# Wheels only: the runtime image ships no compiler, so a source build here is a build-time failure rather than a 3am surprise.
FROM python:${PYTHON_VERSION}-slim-bookworm AS pydeps
COPY backend/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: \
      --prefix=/opt/pydeps -r /tmp/requirements.lock

FROM python:${PYTHON_VERSION}-slim-bookworm

# The X server plus every shared object `ldd` reports the Electron binary wanting, and the fonts without which every page renders as boxes. Derived from ldd on the real binary, not from a blog post.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git ca-certificates \
      xvfb fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxtst6; \
    rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
# npm and npx too, not just node. They are shims into lib/node_modules, so copying the tree and
# re-linking is the only way to get them; a `node` with no `npm` is what left the App Builder
# scaffolding an app it could never install, build or serve.
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=pydeps /opt/pydeps /usr/local

# Numeric owner on every /app copy, because a `chown -R /app` afterwards rewrites the whole tree into a second layer and the image pays for it twice (that cost 493MB before this line existed). Numeric, not `runner`, because the user is created further down.
COPY --from=router --chown=10001:10001 /stage/node_modules/9router/app /app/router
COPY --chown=10001:10001 backend /app/backend
COPY --chown=10001:10001 openswarm-runner/runner /app/runner
COPY --chown=10001:10001 electron /app/electron
COPY --from=shell-deps --chown=10001:10001 /stage/node_modules /app/electron/node_modules
COPY --from=electron --chown=10001:10001 /stage /app/electron-runtime
COPY --from=frontend --chown=10001:10001 /src/dist /app/frontend

# After backend/, never before: mcp_config.resolve_command probes uv-bin last, and the repo's own copy is Mach-O.
COPY --from=uv --chown=10001:10001 /stage/uv /app/backend/uv-bin/uv
COPY --from=uv --chown=10001:10001 /stage/uvx /app/backend/uv-bin/uvx

# Also after backend/, and at the exact path bundled_extracted_modules() looks for.
COPY --from=webapp-template --chown=10001:10001 /out /app/backend/apps/outputs/webapp_template_cache

RUN set -eux; \
    if ls /app/backend/.env* >/dev/null 2>&1; then echo "a dotenv reached the image; fix Dockerfile.dockerignore" >&2; exit 1; fi; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    npm --version >/dev/null; \
    mkdir -p /app/python-env/bin; \
    ln -s /usr/local/bin/python3 /app/python-env/bin/python3; \
    find /app/backend -name '__pycache__' -type d -prune -exec rm -rf {} +; \
    useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner; \
    mkdir -p /data; \
    ln -s /data/openswarm /app/backend/data; \
    mkdir -p /tmp/.X11-unix; \
    chmod 1777 /tmp/.X11-unix; \
    chown runner:runner /data; \
    printf '[user]\n\tname = OpenSwarm Cloud Run\n\temail = cloud-run@openswarm.local\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n' > /etc/gitconfig

USER runner
WORKDIR /app
# RUNNER_MAX_RUN_SECONDS lives in the IMAGE, not in fly.toml: machines are created one
# per run through the Machines API, which ignores fly.toml's [env], so a cap defined
# there would silently not apply to the only machines that ever run a workflow.
ENV HOME=/home/runner \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RUNNER_MAX_RUN_SECONDS=1800 \
    OPENSWARM_HEADLESS=1 \
    OPENSWARM_PACKAGED=1 \
    OPENSWARM_DATA_ROOT=/data/openswarm \
    OPENSWARM_HOST=127.0.0.1 \
    OPENSWARM_PORT=8324 \
    DATA_DIR=/data/9router \
    NODE_ENV=production \
    ELECTRON_BIN=/app/electron-runtime/electron \
    OPENSWARM_RUN_WORKSPACE=/data/workspace \
    OPENSWARM_NODE_PATH=/usr/local/bin/node

ENTRYPOINT ["python3", "-m", "runner.main"]
