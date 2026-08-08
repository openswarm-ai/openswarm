"""One command that re-checks the 1.7.5 contract and prints a scoreboard.

The evidence for this release lived in a scatter of Linear comments, which nobody can re-run. This
script is the reproducible version: every check either prints a number or says out loud that it was
skipped and why. It never reports a pass it did not measure.

    python scripts/verify-175.py            # deterministic checks only (no backend needed)
    python scripts/verify-175.py --live     # also the checks that need a running backend

Deliberately NOT included: the forced-failure battery and the CDP UI proofs. Those need a stack, a
router, and in one case a temporarily hidden CLI binary, so they are run by hand and recorded on
ENG-175. Pretending a script covers them would be the same dishonesty this release spent its time
stamping out.
"""

import json
import os
import statistics
import subprocess
import sys
import time
import urllib.request
from typing import List, Optional, Tuple

from scripts.verify175.forced import (check_boot_lifespan, check_forced_401, check_forced_overflow,
                                       check_forced_router_unavailable, check_forced_silent_noop)
from scripts.verify175.ui import (check_dictation, check_idle_raf, check_inp,
                                   check_long_tasks_on_mount, check_scroll_both_halves)

from scripts.verify175.shared import ROOT, ROWS, p_api, row

PY = os.path.join(ROOT, "backend", ".venv", "bin", "python")


def run(cmd: List[str], timeout: int = 900) -> Tuple[int, str]:
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def check_suite() -> None:
    code, out = run([PY, "-m", "pytest", "backend/tests/", "-q"], timeout=1800)
    tail = [l for l in out.splitlines() if "passed" in l or "failed" in l]
    row("backend suite", "PASS" if code == 0 else "FAIL", tail[-1].strip() if tail else "no summary")


def check_linter() -> None:
    code, out = run([PY, "linter/lint.py"], timeout=900)
    named = ("no-underscore-names", "p-private", "ruff", "pyright", "dangling-refs", "import-cycles")
    # only the "done." summary lines carry a verdict; the "checking..." progress lines are noise
    bad = [l.strip() for l in out.splitlines()
           if l.startswith(named) and "done." in l and "0 error" not in l]
    row("linter (named checks)", "PASS" if not bad else "FAIL", "0 errors" if not bad else "; ".join(bad))


def check_sensor_cost() -> None:
    """The zero-heaviness question is 'do the sensors move the number', and a microbenchmark answers
    it where an E2E A/B cannot: the effect is ~1000x below the provider noise floor."""
    src = (
        "import time,sys; sys.path.insert(0,%r)\n"
        "from backend.apps.agents.core import flight_recorder as fr\n"
        "fr.drop_session('bench')\n"
        "for _ in range(1000): fr.crumb('bench','p',model='m',api='a')\n"
        "t0=time.perf_counter()\n"
        "for _ in range(20000): fr.crumb('bench','p',model='m',api='a')\n"
        "per=(time.perf_counter()-t0)/20000\n"
        "fr.drop_session('bench')\n"
        "print(round(per*1e6,2), round(per*fr.P_RING_SIZE*1e3,3))\n" % ROOT
    )
    code, out = run([PY, "-c", src], timeout=300)
    try:
        us, ring_ms = out.strip().split()[-2:]
        ok = float(ring_ms) < 5.0
        row("sensor cost per turn", "PASS" if ok else "FAIL",
            f"crumb {us}us, full 64-crumb ring {ring_ms}ms (budget 5ms)")
    except Exception:
        row("sensor cost per turn", "SKIP", f"benchmark did not report: {out.strip()[:60]}")


def check_envelope_coverage() -> None:
    code, out = run([PY, "-m", "pytest", "backend/tests/test_every_error_carries_an_envelope.py",
                     "backend/tests/test_provider_retry_ledger.py",
                     "backend/tests/test_router_unavailable_envelope.py",
                     "backend/tests/test_parse_install_command_refusals.py", "-q"], timeout=600)
    tail = [l for l in out.splitlines() if "passed" in l or "failed" in l]
    row("envelope + parser guards", "PASS" if code == 0 else "FAIL", tail[-1].strip() if tail else "no summary")


def check_changelog() -> None:
    src = (
        "import sys; sys.path.insert(0,%r)\n"
        "from backend.apps.help.changelog import all_versions, help_context_block\n"
        "v=all_versions(); b=help_context_block('1.7.5')\n"
        "print(json.dumps({'versions':sorted(v), 'has175': '1.7.5' in b, 'chars': len(b)}))\n"
    ) % ROOT
    code, out = run([PY, "-c", "import json\n" + src], timeout=120)
    try:
        d = json.loads(out.strip().splitlines()[-1])
        ok = d["has175"] and "1.7.5" in d["versions"]
        row("changelog + Help context", "PASS" if ok else "FAIL",
            f"versions={d['versions']}, 1.7.5 in Help block={d['has175']}, {d['chars']} chars")
    except Exception:
        row("changelog + Help context", "FAIL", out.strip()[:70])


def check_live_ttft(token: str) -> None:
    """Always paired with a same-window provider floor: an absolute TTFT number with no floor beside
    it cannot distinguish our regression from the provider having a bad hour."""
    ts = []
    for n in range(5):
        t0 = time.time()
        try:
            sid = p_api("/agents/launch", token, {"name": f"v{n}", "model": "sonnet-cc",
                                                  "dashboard_id": "0bf37aa28ac24bb78a06b084d687587d",
                                                  "prompt": "say pong"})["session_id"]
        except Exception as e:
            row("cold TTFT", "SKIP", f"launch failed: {str(e)[:40]}")
            return
        for _ in range(400):
            time.sleep(0.2)
            s = p_api(f"/agents/sessions/{sid}", token)
            s = s.get("session") if isinstance(s.get("session"), dict) else s
            if s.get("status") == "completed":
                ts.append(time.time() - t0)
                break
        subprocess.run(["curl", "-s", "-X", "DELETE", "-H", f"Authorization: Bearer {token}",
                        f"http://127.0.0.1:8324/api/agents/sessions/{sid}"], capture_output=True)
    floor = []
    filler = "You are a helpful assistant with access to many tools. " * 490
    for _ in range(3):
        body = {"model": "cc/claude-sonnet-4-6", "max_tokens": 16, "system": filler,
                "messages": [{"role": "user", "content": "say pong"}]}
        req = urllib.request.Request("http://localhost:20128/v1/messages", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}",
                                              "anthropic-version": "2023-06-01"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                for _ in r:
                    pass
            floor.append(time.time() - t0)
        except Exception:
            pass
    if not ts:
        row("cold TTFT", "SKIP", "no completed turns")
        return
    med = statistics.median(ts)
    fl = statistics.median(floor) if floor else None
    ours = f", ours={med - fl:.2f}s" if fl else ""
    row("cold TTFT (gate <=2.80s)", "PASS" if med <= 2.80 else "FAIL",
        f"median {med:.2f}s n={len(ts)}" + (f", provider floor {fl:.2f}s{ours}" if fl else ", floor unmeasured"))


def main() -> None:
    live = "--live" in sys.argv or "--live-only" in sys.argv
    only = "--live-only" in sys.argv
    print("\n1.7.5 verification\n" + "=" * 78)
    if not only:
        print("\ndeterministic checks:")
        check_suite()
        check_linter()
        check_sensor_cost()
        check_envelope_coverage()
        check_changelog()
    if live:
        print("\nlive checks (need a running backend):")
        try:
            token = open(os.path.join(ROOT, "backend", "data", "auth.token")).read().strip()
            urllib.request.urlopen("http://127.0.0.1:8324/docs", timeout=3)
        except Exception:
            row("live checks", "SKIP", "backend not reachable on :8324")
        else:
            sink = os.environ.get("OPENSWARM_DIAG_SINK", "")
            # Order matters: boot and TTFT run on a clean stack, the forced-failure checks below
            # kill the router and must come last or they poison both numbers.
            check_boot_lifespan()
            check_live_ttft(token)
            check_forced_silent_noop(token)
            if sink:
                check_forced_overflow(token, sink)
                check_forced_401(token, sink, "reset")
                check_forced_401(token, sink, "dead")
            print("\nCDP checks (need headless Chrome on :9223 against the dev frontend):")
            check_idle_raf()
            # The gate that TTFT/INP/idle all missed: cost at MOUNT, not during a gesture (ENG-193).
            check_long_tasks_on_mount()
            check_inp()
            check_dictation()
            check_scroll_both_halves()
            if sink:
                check_forced_router_unavailable(token, sink)
            else:
                row("forced: router unavailable", "SKIP", "run the backend with OPENSWARM_DIAG_SINK set")
    else:
        print("\nlive checks: skipped (pass --live with a backend running)")
    print("\n" + "=" * 78)
    fails = [r for r in ROWS if r[1] == "FAIL"]
    skips = [r for r in ROWS if r[1] == "SKIP"]
    print(f"{len(ROWS) - len(fails) - len(skips)} pass, {len(fails)} fail, {len(skips)} skipped")
    if fails:
        print("FAILING: " + ", ".join(f"{n} ({d})" for n, _, d in fails))
    print("\nStill hand-run, recorded on ENG-175 (need a hidden CLI binary, Electron, or a signed bundle):")
    print("  forced classes: 401 shims, overflow, missing CLI, webview kill, renderer wedge")
    print("  plus the fly-to-fit/overlay proofs and the packaged-build check.")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
