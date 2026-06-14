#!/usr/bin/env bash
# One-command launcher for the interactive test runner.
#
#   bash backend/tests/run.sh            # discover -> picker -> run
#   bash backend/tests/run.sh -k ingest  # forward any flags/paths to the runner
#
# Two-venv design (see tests/runner/README.md):
#   - runner venv (.runner-venv): UI libs only (typer/rich/textual), never pytest
#   - test venv (backend/.venv):  pytest + project deps; config.json -> venv_python
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../backend/tests
BACKEND_DIR="$(dirname "$HERE")"                        # .../backend

TEST_VENV="$BACKEND_DIR/.venv"
RUNNER_VENV="$HERE/.runner-venv"

# Prefer 3.13 (matches the production/runtime interpreter) but fall back to python3.
PY="${PYTHON:-}"
if [[ -z "$PY" ]]; then
    if command -v python3.13 >/dev/null 2>&1; then PY=python3.13; else PY=python3; fi
fi

# 1) Test venv: project + pytest deps. This is what config.json -> venv_python
#    ("./.venv/bin/python", resolved against repo_root=backend) points at.
#    Installs are skipped when the stamp is newer than both requirements files,
#    so repeat runs are fast and need no network.
TEST_STAMP="$TEST_VENV/.run-sh-deps.stamp"
if [[ ! -x "$TEST_VENV/bin/python" ]]; then
    echo "Creating test venv at $TEST_VENV ..."
    "$PY" -m venv "$TEST_VENV"
fi
if [[ ! -f "$TEST_STAMP" \
      || "$BACKEND_DIR/requirements.txt" -nt "$TEST_STAMP" \
      || "$BACKEND_DIR/requirements-dev.txt" -nt "$TEST_STAMP" ]]; then
    echo "Installing test dependencies ..."
    "$TEST_VENV/bin/pip" install -q \
        -r "$BACKEND_DIR/requirements.txt" \
        -r "$BACKEND_DIR/requirements-dev.txt"
    touch "$TEST_STAMP"
fi

# 2) Runner venv: the UI libraries only (never pytest). These mirror the
#    dependencies declared in tests/runner/pyproject.toml; the package itself is
#    imported straight from the source tree (cwd=backend below), so it does not
#    need to be pip-installed. A stamp keeps repeat runs install-free.
RUNNER_DEPS=(typer rich textual)
RUNNER_STAMP="$RUNNER_VENV/.run-sh-deps.stamp"
if [[ ! -x "$RUNNER_VENV/bin/python" ]]; then
    echo "Creating runner venv at $RUNNER_VENV ..."
    "$PY" -m venv "$RUNNER_VENV"
fi
if [[ ! -f "$RUNNER_STAMP" ]]; then
    echo "Installing runner UI dependencies ..."
    "$RUNNER_VENV/bin/pip" install -q "${RUNNER_DEPS[@]}"
    touch "$RUNNER_STAMP"
fi

# 3) Launch the parent from backend/ so `from tests.runner...` resolves, and
#    forward any args/flags straight through to the Typer CLI.
cd "$BACKEND_DIR"
exec "$RUNNER_VENV/bin/python" -m tests.runner "$@"
