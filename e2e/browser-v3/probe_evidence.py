"""Where does a browser run's page text actually SURFACE? Answer it before trusting any audit.

The canary proves a write landed by looking for the marker string in evidence the model did not
author. It has been looking in the backend LOG, and the backend never logs page text: a grep for
every canary marker ever generated across every backend log on this box returns nothing. So the
audit could only ever return "could not look", which is exactly what LinkedIn and reddit scored.

This probe runs one read-only task and dumps every place the marker could live (parent session
messages, child sessions, tool results), so the replacement evidence channel is chosen on evidence
rather than on where I assume the text goes.
"""

import json
import os
import sys
import time
import urllib.request

# Repo root, derived from this file (e2e/browser-v3/x.py -> two levels up). Hardcoding an
# absolute path made this harness silently useless on any other checkout.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("OSW_BASE", "http://127.0.0.1:8326") + "/api/agents"
MODEL = "opus-4-8"


def req(method: str, url: str, body=None):
    tok = open(os.path.join(ROOT, "backend/data/auth.token")).read().strip()
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json",
                                        "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(r, timeout=260) as resp:
        return json.loads(resp.read().decode() or "{}")


def walk(node, path="", out=None, needle=""):
    """Every JSON path whose leaf string contains `needle`."""
    out = [] if out is None else out
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, f"{path}.{k}", out, needle)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, f"{path}[{i}]", out, needle)
    elif isinstance(node, str) and needle and needle in node:
        out.append((path, node[:160]))
    return out


def main() -> int:
    task = sys.argv[1]
    needle = sys.argv[2]
    dash = req("GET", BASE.replace("/agents", "") + "/dashboards/list")
    ds = dash if isinstance(dash, list) else dash.get("dashboards", [])
    sid = req("POST", f"{BASE}/launch", {"mode": "agent", "model": MODEL, "provider": "anthropic",
                                         "dashboard_id": ds[0]["id"], "name": "probe-evidence"})["session"]["id"]
    print(f"session {sid}\ntask   {task}\nneedle {needle}\n", flush=True)
    t0 = time.time()
    try:
        req("POST", f"{BASE}/sessions/{sid}/message", {"prompt": task, "mode": "agent", "model": MODEL})
    except Exception:
        pass
    status = ""
    while time.time() - t0 < 240:
        try:
            s = req("GET", f"{BASE}/sessions/{sid}")
            status = str(s.get("status") or "")
            if status in ("completed", "error", "stopped"):
                break
        except Exception:
            pass
        time.sleep(2)
    time.sleep(2)

    s = req("GET", f"{BASE}/sessions/{sid}")
    print(f"status={status} wall={round(time.time()-t0,1)}s")
    print(f"parent top-level keys: {sorted(s.keys())}")
    print(f"parent messages: {len(s.get('messages') or [])}")
    hits = walk(s, "session", needle=needle)
    print(f"\n--- marker in PARENT session json: {len(hits)} hits ---")
    for p, v in hits[:14]:
        print(f"  {p}\n      {v!r}")

    # Child sessions: the sub-agent path puts the browser work in its own session.
    kids = []
    try:
        allsess = req("GET", f"{BASE}/sessions")
        rows = allsess if isinstance(allsess, list) else allsess.get("sessions", [])
        kids = [r for r in rows if str(r.get("parent_session_id") or "") == sid]
    except Exception as e:
        print(f"(child enumeration failed: {e})")
    print(f"\n--- child sessions: {len(kids)} ---")
    for k in kids:
        full = req("GET", f"{BASE}/sessions/{k['id']}")
        kh = walk(full, "child", needle=needle)
        print(f"  {k['id']} name={k.get('name')!r} msgs={len(full.get('messages') or [])} marker_hits={len(kh)}")
        for p, v in kh[:8]:
            print(f"      {p}\n          {v!r}")

    json.dump(s, open(os.environ.get("OSW_DUMP", "/tmp/probe_session.json"), "w"), indent=1)
    print(f"\nfull parent dump -> {os.environ.get('OSW_DUMP', '/tmp/probe_session.json')}")
    try:
        req("DELETE", f"{BASE}/sessions/{sid}")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
