#!/bin/bash
# Run the backend pytest suite. Creates backend/.venv if missing, installs
# requirements.txt + requirements-dev.txt the first time (or whenever
# pytest isn't importable), then invokes pytest.
#
# Usage:
#   bash scripts/test.sh                    # run everything (~30s; 500 stress iters)
#   bash scripts/test.sh --quick            # cap DISCONNECT_STRESS_N at 20 for fast iteration
#   bash scripts/test.sh -k disconnect      # forward any pytest args
#   bash scripts/test.sh backend/tests/test_analytics.py -v
#
# Env:
#   DISCONNECT_STRESS_N   Override the stress-iteration count for
#                         test_disconnect_resilience.py (default 500;
#                         --quick sets it to 20).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
VENV_DIR="$BACKEND_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"

# --- Parse our one wrapper flag, then forward the rest to pytest ----------
QUICK=0
PYTEST_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --quick) QUICK=1 ;;
        *) PYTEST_ARGS+=("$arg") ;;
    esac
done

# --- Ensure venv exists ---------------------------------------------------
if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "==> Creating venv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi

# Pinned to project root so:
#   1. `from backend.apps...` imports resolve when pytest runs (same as
#      before — see end of file).
#   2. The `-e ./debugger` line in backend/requirements-dev.txt resolves
#      correctly. pip resolves relative paths in requirements files
#      relative to CWD, not the requirements file's directory.
cd "$PROJECT_ROOT"

# --- Ensure pytest is installed (idempotent: only re-installs if missing) -
if ! "$PYTHON_BIN" -c "import pytest, pytest_asyncio, pytest_cov" >/dev/null 2>&1; then
    echo "==> Installing backend deps + dev deps into $VENV_DIR"
    "$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
    "$PYTHON_BIN" -m pip install \
        -r "$BACKEND_DIR/requirements.txt" \
        -r "$BACKEND_DIR/requirements-dev.txt"
fi

# --- Default target = backend/tests/ if caller didn't pass any path -------
if [[ ${#PYTEST_ARGS[@]} -eq 0 ]]; then
    PYTEST_ARGS=(backend/tests/ -v)
fi

# --- --quick: dial the disconnect stress loop way down --------------------
if [[ "$QUICK" -eq 1 ]]; then
    export DISCONNECT_STRESS_N="${DISCONNECT_STRESS_N:-20}"
    echo "==> --quick: DISCONNECT_STRESS_N=$DISCONNECT_STRESS_N"
fi

# --- Coverage flags (always on; see .coveragerc for source/omit rules) ----
COVERAGE_ARGS=(
    --cov=backend
    --cov-report=term-missing
    --cov-report=html:backend/coverage_html
    --cov-report=xml:backend/coverage.xml
)

# Already cd'd to $PROJECT_ROOT above so `from backend.apps...` resolves.
echo "==> Running: pytest ${COVERAGE_ARGS[*]} ${PYTEST_ARGS[*]}"
# Disable errexit around pytest so we still print the HTML report path on
# failure (and propagate pytest's exit code).
set +e
"$PYTHON_BIN" -m pytest "${COVERAGE_ARGS[@]}" "${PYTEST_ARGS[@]}"
status=$?
set -e
echo "==> HTML coverage report: $PROJECT_ROOT/backend/coverage_html/index.html"
exit $status
