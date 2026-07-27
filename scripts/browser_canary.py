"""Drift canary for the browser write path.

WHY THIS EXISTS: on 2026-07-21 X renamed its compose control and our sends silently went to 0/2
WITH false success claims. No code of ours changed. A passing test suite is a snapshot; sites move
underneath it, so the only way a coverage claim stays true is to re-prove it against the live site
on a schedule and shout the day it breaks.

WHAT IT DOES: per site, one full round trip on the user's own account, then cleans up after itself:
    post a unique marker -> confirm the receipt -> delete it -> confirm it is gone
A site "passes" only if the post was receipt-verified AND the cleanup verified gone. Anything else
is drift, reported with the stage it died at.

SAFETY:
  - Never runs by itself. No cron, no import side effects; a human or a CI job invokes it.
  - --dry (default) posts NOTHING: it exercises discovery only, so it is safe anywhere.
  - --live is required to actually post, and every post is deleted in the same run.
  - Markers are random and carry no removal words ("delete"/"remove" in a payload trips the
    removal classifier and makes the send path stand down, which cost us a confusing hour once).
  - Exits 1 on drift so a scheduler can alert on it.

USAGE
    python scripts/browser_canary.py                     # discovery only, posts nothing
    python scripts/browser_canary.py --live              # real round trip, self-cleaning
    python scripts/browser_canary.py --live --sites x,reddit
    (backend must be running; set OSW_CANARY_BASE if it is not on :8326)
"""

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.request
from typing import Dict, List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get("OSW_CANARY_BASE", "http://127.0.0.1:8326") + "/api/agents"
LOG = os.environ.get("OSW_CANARY_LOG", "/tmp/osw_backend_mr.log")
MODEL = os.environ.get("OSW_CANARY_MODEL", "opus-4-8")

# Per site: how to post it, how to delete it. Kept deliberately small: these are the surfaces we
# CLAIM to support, so the canary's job is to keep that claim honest, not to explore new ones.
SITES: Dict[str, Dict[str, str]] = {
    "x": {
        "probe": 'Go to x.com. Do NOT type or post anything. Is the tweet compose box present on the page? Answer with exactly one word: YES or NO.',
        "post": 'Go to x.com and post this tweet, exactly: "{m}"',
        "delete": 'Go to x.com/{handle} and delete the post that says "{m}"',
        "handle_env": "OSW_CANARY_X_HANDLE",
    },
    "linkedin": {
        "probe": 'Go to linkedin.com. Do NOT type or post anything. Is the "Start a post" compose control present on the feed? Answer with exactly one word: YES or NO.',
        "post": 'Go to linkedin.com and create a post with exactly this text: "{m}"',
        "delete": 'Go to my LinkedIn activity and delete the post that says "{m}"',
    },
    "reddit": {
        "probe": 'Go to reddit.com/r/test/submit. Do NOT type or submit anything. Is the post title/body compose form present? Answer with exactly one word: YES or NO.',
        "post": 'Go to reddit.com and create a text post in r/test titled "{m}" with body "canary check". Submit it.',
        "delete": 'Go to reddit.com and delete my post titled "{m}"',
    },
}


def req(method: str, url: str, body: Optional[dict] = None) -> dict:
    tok = open(os.path.join(ROOT, "backend/data/auth.token")).read().strip()
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json",
                                        "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(r, timeout=260) as resp:
        return json.loads(resp.read().decode() or "{}")


def log_lines() -> int:
    try:
        return sum(1 for _ in open(LOG, errors="ignore"))
    except OSError:
        return 0


def run_task(prompt: str, name: str, budget: int = 180) -> Dict[str, object]:
    """Dispatch one browser task; return {said, status, wall, log} for the slice it produced."""
    mark = log_lines()
    dash = req("GET", BASE.replace("/agents", "") + "/dashboards/list")
    dashboards = dash if isinstance(dash, list) else dash.get("dashboards", [])
    if not dashboards:
        return {"said": "", "status": "error", "wall": 0.0, "log": "", "err": "no dashboard"}
    sid = req("POST", f"{BASE}/launch", {"mode": "agent", "model": MODEL, "provider": "anthropic",
                                         "dashboard_id": dashboards[0]["id"], "name": name})["session"]["id"]
    t0 = time.time()
    try:
        req("POST", f"{BASE}/sessions/{sid}/message", {"prompt": prompt, "mode": "agent", "model": MODEL})
    except Exception:
        pass
    status = ""
    said = ""
    while time.time() - t0 < budget:
        try:
            s = req("GET", f"{BASE}/sessions/{sid}")
            status = str(s.get("status") or "")
            if status in ("completed", "error", "stopped"):
                msgs = [m for m in s.get("messages", []) if m.get("role") == "assistant"]
                if msgs:
                    c = msgs[-1].get("content")
                    said = c if isinstance(c, str) else str(c)
                break
        except Exception:
            pass
        time.sleep(1.5)
    time.sleep(1.0)
    try:
        slice_ = "".join(open(LOG, errors="ignore").readlines()[mark:])
    except OSError:
        slice_ = ""
    return {"said": said, "status": status, "wall": round(time.time() - t0, 1), "log": slice_}


def check_site(site: str, cfg: Dict[str, str], live: bool) -> Dict[str, object]:
    marker = "canary" + secrets.token_hex(4)          # no removal words, unique per run
    res: Dict[str, object] = {"site": site, "marker": marker, "live": live}

    if not live:
        # Discovery-only, safe BY CONSTRUCTION rather than by configuration: we ask the agent to
        # REPORT whether the compose surface is reachable, never to write. An earlier draft set
        # OSW_SENDSCRIPT_DRYRUN in this process, which does nothing to the backend, so a "dry" run
        # against a normal backend would have posted for real. Never trust a flag you don't own.
        r = run_task(cfg["probe"].format(handle=os.environ.get(cfg.get("handle_env", ""), "")),
                     f"canary-probe-{site}")
        said = str(r["said"])
        found = bool(re.search(r"\bYES\b", said)) and not re.search(r"\bNO\b", said)
        if "sent_receipt=True" in str(r["log"]):        # must never happen on this path
            res.update(stage="SAFETY", ok=False,
                       detail="ABORT: a discovery probe performed a real send; check the task text")
            return res
        res.update(stage="discovery", ok=found, wall=r["wall"],
                   detail=("compose surface reachable" if found else f"NOT reachable: {said[:110]}"))
        return res

    # 1. POST, and require the two-sided receipt (composer cleared), not the model's word for it.
    handle = os.environ.get(cfg.get("handle_env", ""), "") if cfg.get("handle_env") else ""
    r = run_task(cfg["post"].format(m=marker, handle=handle), f"canary-post-{site}")
    log = str(r["log"])
    delivered = "done sent_receipt=True" in log or "DELIVERY CONFIRMED" in log
    res["post_wall"] = r["wall"]
    if not delivered:
        res.update(stage="post", ok=False,
                   detail=f"no receipt (status={r['status']}): {str(r['said'])[:120]}")
        return res

    # 2. DELETE, and require the in-page verify-gone, so cleanup can't be claimed falsely.
    d = run_task(cfg["delete"].format(m=marker, handle=handle), f"canary-clean-{site}")
    dlog = str(d["log"])
    removed = "removed=True" in dlog
    res["delete_wall"] = d["wall"]
    if not removed:
        res.update(stage="cleanup", ok=False,
                   detail=f"POSTED BUT NOT CLEANED, marker {marker} may be live: {str(d['said'])[:100]}")
        return res
    res.update(stage="done", ok=True, detail="posted, receipt-verified, deleted, verified gone")
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live", action="store_true",
                    help="actually post (and delete) on the real accounts; default is discovery-only")
    ap.add_argument("--sites", default="", help="comma list (default: all)")
    args = ap.parse_args()

    want: List[str] = [s.strip() for s in args.sites.split(",") if s.strip()] or list(SITES)
    unknown = [s for s in want if s not in SITES]
    if unknown:
        print(f"unknown site(s): {', '.join(unknown)}; known: {', '.join(SITES)}")
        return 2

    print(f"browser drift canary  mode={'LIVE (posts+deletes)' if args.live else 'discovery-only'}  "
          f"sites={','.join(want)}  model={MODEL}")
    rows = []
    for s in want:
        r = check_site(s, SITES[s], args.live)
        rows.append(r)
        flag = "PASS" if r.get("ok") else "DRIFT"
        print(f"  [{flag}] {s:10} stage={r.get('stage','?'):10} {r.get('detail','')}", flush=True)

    bad = [r for r in rows if not r.get("ok")]
    stranded = [r for r in bad if r.get("stage") == "cleanup"]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} sites healthy")
    if stranded:
        print("!! MANUAL CLEANUP NEEDED: " + ", ".join(f"{r['site']}:{r['marker']}" for r in stranded))
    if bad:
        print("DRIFT DETECTED on: " + ", ".join(str(r["site"]) for r in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
