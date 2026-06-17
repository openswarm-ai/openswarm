"""Granular App Builder first-app create/"download" profiler (winv2 Task #3).

Incremental + bounded: each phase appends to appbuilder_breakdown.csv and flushes
the instant it finishes, so a slow/hung later phase can't erase earlier numbers.
Run UNBUFFERED (python -u) so progress is visible mid-run. Cheap phases first.

Phases:
  1. seed workspace + link node_modules  (per-app cost, uses real warm cache)
  2. download: npm install (cold, no archive)  (the "slow as bricks" download)
  3. download: archive extract (new build path)  (tar the just-installed nm, time extract)
  4. vite bind: cold vite cache (first app ever)
  5. vite bind: warm shared cache (subsequent apps)

Isolated temp dirs; never mutates the user's real caches (read-only link to the
warm node_modules cache; vite cache is overridden to temp for the cold case).
"""
import asyncio
import os
import shutil
import subprocess
import tarfile
import tempfile
import time

from backend.apps.outputs import view_builder_templates as vt
from backend.apps.outputs.runtime_proc import _find_free_port
from backend.apps.outputs.runtime import AppRuntime

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "appbuilder_breakdown.csv")
TMP = tempfile.mkdtemp(prefix="ab-measure-")
TMPL_FRONTEND = os.path.join(vt.WEBAPP_TEMPLATE_DIR, "frontend")
VITE_DEADLINE = 90

with open(CSV, "w", encoding="utf-8") as f:
    f.write("phase,ms,note\n")


def lap(t):
    return round((time.perf_counter() - t) * 1000)


def record(name, ms, note=""):
    print(f"{ms:8d} ms  {name}" + (f"   ({note})" if note else ""), flush=True)
    with open(CSV, "a", encoding="utf-8") as f:
        f.write(f'"{name}",{ms},"{note}"\n')
        f.flush()


def phase_seed():
    ws = os.path.join(TMP, "ws-seed")
    t = time.perf_counter()
    vt.seed_webapp_template_workspace(ws, _find_free_port())
    ms = lap(t)
    present = os.path.exists(os.path.join(ws, "frontend", "node_modules"))
    record("seed workspace + link node_modules (per app)", ms, "nm linked" if present else "NO nm")


def phase_npm_and_extract():
    npm = vt._resolve_npm()
    if not npm:
        record("download: npm install (cold)", -1, "skipped: no npm")
        return
    work = os.path.join(TMP, "npm_cold")
    os.makedirs(work, exist_ok=True)
    shutil.copyfile(os.path.join(TMPL_FRONTEND, "package.json"), os.path.join(work, "package.json"))
    lock = os.path.join(TMPL_FRONTEND, "package-lock.json")
    cmd = [*npm, "install", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"]
    if os.path.exists(lock):
        shutil.copyfile(lock, os.path.join(work, "package-lock.json"))
        cmd = [*npm, "ci", "--prefer-offline", "--no-audit", "--no-fund", "--loglevel=error"]
    t = time.perf_counter()
    try:
        r = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=240)
        record("download: npm install (cold, no archive)", lap(t), "ok" if r.returncode == 0 else f"rc={r.returncode}")
    except subprocess.TimeoutExpired:
        record("download: npm install (cold, no archive)", -1, "TIMEOUT 240s")
        return

    nm = os.path.join(work, "node_modules")
    if not os.path.isdir(nm):
        return
    # Reuse that node_modules to time the archive build + extract (new path).
    archive = os.path.join(TMP, "nm.tar.gz")
    t = time.perf_counter()
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(nm, arcname="node_modules")
    record("build-time: tar node_modules -> archive", lap(t), f"{os.path.getsize(archive)//(1024*1024)}MB")
    exd = os.path.join(TMP, "extract"); os.makedirs(exd, exist_ok=True)
    t = time.perf_counter()
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(exd)
    record("download: archive extract (new build path)", lap(t))


async def _bind_once(label, vite_cache_dir):
    ws = os.path.join(TMP, f"ws-{label}")
    vt.seed_webapp_template_workspace(ws, _find_free_port())
    if vite_cache_dir:
        os.environ["OPENSWARM_VITE_CACHE_DIR"] = vite_cache_dir
    else:
        os.environ.pop("OPENSWARM_VITE_CACHE_DIR", None)
    rt = AppRuntime(f"ws-{label}", ws)
    t = time.perf_counter()
    await rt.start()
    deadline = time.perf_counter() + VITE_DEADLINE
    while rt.frontend_url is None and time.perf_counter() < deadline:
        await asyncio.sleep(0.1)
    bound = rt.frontend_url is not None
    ms = lap(t) if bound else -1
    try:
        await rt.stop()
    except Exception:
        pass
    record(f"vite bind ({label})", ms, "bound" if bound else f"TIMEOUT {VITE_DEADLINE}s")


async def main():
    print(f"temp: {TMP}", flush=True)
    for fn in (phase_seed, phase_npm_and_extract):
        try:
            fn()
        except Exception as e:
            record(fn.__name__, -1, f"ERR {type(e).__name__}: {e}")
    for label, cache in (("cold vite cache", os.path.join(TMP, "vite_cold")), ("warm shared cache", None)):
        try:
            await _bind_once(label, cache)
        except Exception as e:
            record(f"vite bind ({label})", -1, f"ERR {type(e).__name__}: {e}")
    print("done", flush=True)
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
