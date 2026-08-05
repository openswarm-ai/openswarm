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
        "verify": ('Go to x.com/{handle}. Do NOT post, delete or change anything. Is there a post '
                   'containing "{m}"? Answer with exactly one word: GONE if absent, PRESENT if there.'),
        "handle_env": "OSW_CANARY_X_HANDLE",
    },
    "linkedin": {
        "probe": 'Go to linkedin.com. Do NOT type or post anything. Is the "Start a post" compose control present on the feed? Answer with exactly one word: YES or NO.',
        "post": 'Go to linkedin.com and create a post with exactly this text: "{m}"',
        "delete": 'Go to my LinkedIn activity and delete the post that says "{m}"',
        "verify": ('Go to my LinkedIn activity. Do NOT post, delete or change anything. Is there a post '
                   'containing "{m}"? Answer with exactly one word: GONE if absent, PRESENT if there.'),
    },
    "reddit": {
        "probe": 'Go to reddit.com/r/test/submit. Do NOT type or submit anything. Is the post title/body compose form present? Answer with exactly one word: YES or NO.',
        # ONE quoted span, deliberately. The old wording quoted a title AND a body, and
        # quoted_payload refuses a task with two candidate payloads rather than guess which text to
        # send, which is correct: guessing there is how you post the wrong string. So the send
        # script declined every reddit round, the model finished it the slow way, no receipt fired,
        # and the canary scored the PRODUCT for a defect in this prompt. A measurement instrument
        # that trips the thing it is measuring reports its own bug as the system's.
        "post": 'Go to reddit.com/r/test/submit and create a text post whose title is exactly "{m}". Submit it.',
        "delete": 'Go to reddit.com and delete my post titled "{m}"',
        "verify": ('Go to my reddit profile. Do NOT post, delete or change anything. Is there a post '
                   'titled "{m}"? Answer with exactly one word: GONE if absent, PRESENT if there.'),
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


def marker_in_page(cfg: Dict[str, str], marker: str, handle: str, site: str) -> Optional[bool]:
    """Is the marker ACTUALLY on the destination page? None when the read could not be made.

    The two checks around this one both take somebody's word for it. `sent_receipt=True` is OUR
    mechanism reporting on itself, so a receipt bug reads as a delivered post; and the GONE/PRESENT
    reply is a model summarising a page, which is the same model whose claim we are trying to audit.
    Neither is destination-specific evidence.

    This reads the raw perception instead: navigate fresh, then grep the tool output in the log for
    the marker string. No model judgement is consulted, only whether those characters came back from
    the page. That is what makes a "posted" claim falsifiable, which is the whole point of counting
    false successes.
    """
    if not cfg.get("verify"):
        return None
    v = run_task(cfg["verify"].format(m=marker, handle=handle), f"canary-audit-{site}")
    log = str(v["log"])
    if not log.strip():
        return None
    # "the marker is not on the page" and "we never got a good look at the page" are DIFFERENT
    # answers, and collapsing them is how this audit falsely accused LinkedIn of a false success:
    # the post was really there (the cleanup that followed deleted it), the read just never
    # surfaced its text. Absence only counts as evidence once the read itself is known good, so
    # require proof we saw the destination at all before believing what we did not see on it.
    # Any evidence the audit run actually looked at a page. The first version listed two exact
    # "[browser-action] X" strings the log does not emit for reads, so saw_page was always False and
    # every audit returned "unprovable" no matter what it saw. An instrument that can only ever say
    # "don't know" is worse than none, because it looks like data.
    saw_page = any(k in log for k in ("BrowserGetText", "BrowserListInteractives",
                                      "dryrun-report", "browser-action", "browser-time"))
    # Excluding every "browser-action" line was the bug that made this instrument dangerous. Tool
    # RESULTS are logged on those lines too, so the one place the page's own text appears was being
    # filtered out, and a post that was really there could only ever come back "not on the
    # destination" — i.e. a FALSE SUCCESS accusation against a send that worked. Measured on
    # LinkedIn: this reported `canaryffaf69d7 is not on the destination` while an independent read
    # found it as the most recent post, 7 minutes old, 14 impressions.
    #
    # Exclude only the echo of the prompt WE sent, matched on its own distinctive wording, and keep
    # everything else the run logged.
    p_echo = ("is there a post", "do not post", "answer with exactly one word", "read only")
    hit = any(marker in line for line in log.splitlines()
              if not any(e in line.lower() for e in p_echo))
    if hit:
        return True
    # Absence is only evidence once the read is known good, AND only when we are sure we are not
    # simply blind to page text. If nothing at all in this log carried the marker, including the
    # prompt echo that certainly contained it, then this instrument saw nothing and must say so.
    if marker not in log:
        return None
    return False if saw_page else None


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
    # What the run TOLD the user, kept apart from what the page shows, because the gap between the
    # two is the number that matters. A claim with no evidence under it is a false success, and it
    # cannot be counted at all unless the two are recorded separately.
    said = str(r["said"])
    res["claimed"] = delivered or bool(
        re.search(r"\b(posted|published|tweeted|submitted|sent it|has been posted)\b", said, re.I))
    proven = marker_in_page(cfg, marker, handle, site)
    res["proven"] = proven
    res["false_success"] = bool(res["claimed"]) and proven is False
    if not delivered:
        res.update(stage="post", ok=False,
                   detail=f"no receipt (status={r['status']}): {said[:120]}")
        return res
    if proven is False:
        # The receipt fired and the destination does not have it. This is exactly the failure the
        # canary was built for, and it must never be reported as a pass.
        res.update(stage="post", ok=False,
                   detail=f"FALSE SUCCESS: receipt says sent, {marker} is not on the destination")
        return res

    # 2. DELETE, and require the in-page verify-gone, so cleanup can't be claimed falsely.
    d = run_task(cfg["delete"].format(m=marker, handle=handle), f"canary-clean-{site}")
    dlog = str(d["log"])
    removed = "removed=True" in dlog
    res["delete_wall"] = d["wall"]
    if not removed and cfg.get("verify") is not None:
        # Same evidence channel as the post audit: gone means the characters are not coming back
        # from the page, not that a model said "GONE".
        still_there = marker_in_page(cfg, marker, handle, site)
        if still_there is False:
            removed = True
            res["verified_by"] = "marker absent from raw page text"
    if not removed and cfg.get("verify"):
        # `removed=True` only exists on the BrowserDeleteItem dispatch path. A model-driven delete is
        # every bit as real, and grepping for the mechanism called DRIFT on a delete that had plainly
        # worked: X said "Your post was deleted" and an independent profile audit found the marker
        # gone, twice. A canary that cries wolf gets ignored, which is worse than no canary, so the
        # authority here is the OUTCOME (is it still on the page?) and never the implementation detail.
        v = run_task(cfg["verify"].format(m=marker, handle=handle), f"canary-verify-{site}")
        vsaid = str(v["said"])
        removed = bool(re.search(r"\bGONE\b", vsaid, re.I)) and not re.search(r"\bPRESENT\b", vsaid, re.I)
        res["verify_wall"] = v["wall"]
        res["verified_by"] = "re-read" if removed else "re-read (still present)"
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
    if args.live:
        proven = [r for r in rows if r.get("proven") is True]
        unprovable = [r for r in rows if r.get("proven") is None]
        liars = [r for r in rows if r.get("false_success")]
        print(f"verified writes: {len(proven)}/{len(rows)} proven on the destination"
              + (f", {len(unprovable)} unprovable (no audit read)" if unprovable else ""))
        print(f"FALSE SUCCESS CLAIMS: {len(liars)}"
              + (" <- hard gate, must be 0: " + ", ".join(str(r["site"]) for r in liars)
                 if liars else ""))
    if stranded:
        print("!! MANUAL CLEANUP NEEDED: " + ", ".join(f"{r['site']}:{r['marker']}" for r in stranded))
    if bad:
        print("DRIFT DETECTED on: " + ", ".join(str(r["site"]) for r in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
