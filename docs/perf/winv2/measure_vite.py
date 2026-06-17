"""Vite-bind-only measurement (winv2 Task #3, part 2).

Split out from measure_appbuilder.py because Python's tarfile gzip of a full
node_modules is pathologically slow and was eating the time budget before the
vite phases ran. This does ONLY the two vite binds (cold vite cache = first app
ever; warm shared cache = subsequent apps) and APPENDS to appbuilder_breakdown.csv.
No tar, no npm. Run unbuffered.
"""
import asyncio
import os
import shutil
import tempfile
import time

from backend.apps.outputs import view_builder_templates as vt
from backend.apps.outputs.runtime_proc import _find_free_port
from backend.apps.outputs.runtime import AppRuntime

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "appbuilder_breakdown.csv")
TMP = tempfile.mkdtemp(prefix="ab-vite-")
VITE_DEADLINE = 100


def record(name, ms, note=""):
    print(f"{ms:8d} ms  {name}" + (f"   ({note})" if note else ""), flush=True)
    with open(CSV, "a", encoding="utf-8") as f:
        f.write(f'"{name}",{ms},"{note}"\n')
        f.flush()


async def bind_once(label, vite_cache_dir):
    ws = os.path.join(TMP, f"ws-{label.replace(' ', '_')}")
    vt.seed_webapp_template_workspace(ws, _find_free_port())
    if not os.path.exists(os.path.join(ws, "frontend", "node_modules")):
        record(f"vite bind ({label})", -1, "no node_modules linked")
        return
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
    ms = round((time.perf_counter() - t) * 1000) if bound else -1
    try:
        await rt.stop()
    except Exception:
        pass
    record(f"vite bind ({label})", ms, "bound" if bound else f"TIMEOUT {VITE_DEADLINE}s")


async def main():
    print(f"temp: {TMP}", flush=True)
    for label, cache in (("cold vite cache", os.path.join(TMP, "vite_cold")),
                         ("warm shared cache", None)):
        try:
            await bind_once(label, cache)
        except Exception as e:
            record(f"vite bind ({label})", -1, f"ERR {type(e).__name__}: {e}")
    print("done", flush=True)
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
