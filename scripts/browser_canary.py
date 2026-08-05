"""Drift canary for the browser write path.

WHY THIS EXISTS: on 2026-07-21 X renamed its compose control and our sends silently went to 0/2
WITH false success claims. No code of ours changed. A passing test suite is a snapshot; sites move
underneath it, so the only way a coverage claim stays true is to re-prove it against the live site
on a schedule and shout the day it breaks.

WHAT IT DOES: per site, one full round trip on the user's own account, then cleans up after itself:
    post a unique marker -> confirm the receipt -> delete it -> confirm it is gone
A site "passes" only if the post was receipt-verified AND the cleanup verified gone. Anything else
is drift, reported with the stage it died at.

"Confirm" means the canary drives a browser card to the destination itself and reads
document.body.innerText (see `marker_in_page`). It never asks a model whether the post is there,
and it never takes the receipt's word for it: those are the two claims under audit.

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
from urllib.parse import urlparse

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
        "audit": "https://x.com/{handle}",
        "handle_env": "OSW_CANARY_X_HANDLE",
    },
    "linkedin": {
        "probe": 'Go to linkedin.com. Do NOT type or post anything. Is the "Start a post" compose control present on the feed? Answer with exactly one word: YES or NO.',
        "post": 'Go to linkedin.com and create a post with exactly this text: "{m}"',
        "delete": 'Go to my LinkedIn activity and delete the post that says "{m}"',
        "audit": "https://www.linkedin.com/in/me/recent-activity/all/",
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
        # The AUTHOR's own submitted list, not r/test/new. reddit's spam filter removes automated
        # posts from the subreddit listing within minutes while leaving them on the author's
        # profile, so auditing the subreddit would call a post that genuinely landed a false
        # success. Auditing where the author can see it separates "we never posted" from "reddit
        # removed it", which are different bugs with different owners.
        "audit": "https://www.reddit.com/user/helciminc/submitted/",
    },
}

# Every line the product emits when a write is receipt-VERIFIED. There are two producers and the
# canary knew about one of them, plus one string ("DELIVERY CONFIRMED") that appears nowhere in the
# backend at all and therefore could never match. So a write completed through the agent loop, which
# is what LinkedIn does, was recorded as "no receipt" while the run's own words were the verbatim
# receipt-verified message. Grep for the strings the code actually prints, and keep this next to the
# code that prints them.
P_RECEIPT_MARKERS = (
    "done sent_receipt=True",          # browser_send_script.py, the fast lane
    "two-sided receipt passed",        # browser_agent.py, the agent loop
    "code-send delivered (receipt verified)",   # browser_agent.py, post-fill autosend
)


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


def run_task(prompt: str, name: str, budget: int = 300, keep: bool = False) -> Dict[str, object]:
    """Dispatch one browser task; return {said, status, wall, log} for the slice it produced.

    `keep` leaves the session (and therefore its browser card) alive so the caller can audit the
    destination through that card before tearing it down. The caller MUST call `teardown(sid)`.
    """
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
    if not keep:
        teardown(sid)
    return {"said": said, "status": status, "wall": round(time.time() - t0, 1), "log": slice_,
            "sid": sid}


def teardown(sid: str) -> None:
    """Stop a run and reap its browser card.

    Each canary round launches several sessions and each leaves a live browser card with its own
    webview; a multi-round loop stacks them until the renderer is compositing dozens and stops
    answering, which then reads as a product failure. delete_session stops the browser-agent
    children first, so this reaps the cards too.
    """
    try:
        req("DELETE", f"{BASE}/sessions/{sid}")
    except Exception:
        pass


def p_cards() -> List[str]:
    """Browser cards currently on the dashboard, newest last."""
    dash = req("GET", BASE.replace("/agents", "") + "/dashboards/list")
    ds = dash if isinstance(dash, list) else dash.get("dashboards", [])
    if not ds:
        return []
    full = req("GET", BASE.replace("/api/agents", "/api/dashboards") + "/" + ds[0]["id"])
    cards = (full.get("layout") or {}).get("browser_cards") or {}
    return list(cards)


def p_cmd(browser_id: str, action: str, params: dict) -> dict:
    return req("POST", BASE.replace("/api/agents", "/api/browser") + "/command",
               {"action": action, "browser_id": browser_id, "params": params})


def marker_in_page(url: str, marker: str) -> Optional[bool]:
    """Is the marker ACTUALLY rendered on `url`? None when the read could not be made.

    THE INSTRUMENT THIS REPLACES COULD NOT ANSWER THE QUESTION. It looked for the marker in the
    backend LOG, and the backend does not log page text: a grep for every canary marker ever
    generated, across every backend log on this box, returns zero lines. So the audit could only
    ever say "could not look", and LinkedIn and reddit scored `unprovable` for reasons that had
    nothing to do with LinkedIn or reddit. The session API is no better: it carries the model's
    ANSWER, never the tool results, so reading it is asking the same model we are trying to audit.

    So read the page directly. Drive a real browser card through /api/browser/command (the same
    channel the agent's tools use), navigate to the destination, and pull `document.body.innerText`.
    No model is consulted at any point, which is what makes a "posted" claim falsifiable.

    Poll rather than sleep once: a fresh post can take a few seconds to appear in a feed, and
    calling absence early would invent a failure. Missing evidence is None, never False, because
    asserting absence from a read that did not happen is the same lie as claiming a delivery nobody
    saw, just pointed the other way.
    """
    want_host = (urlparse(url).hostname or "").lower().replace("www.", "")
    saw_page = False
    # Try every card, newest first. A card whose session was torn down mid-run can WEDGE: it answers
    # `navigate` with "Navigated to <url>" in ~80ms and never leaves the page it was on. Measured
    # here on a reddit card that reported a successful hop to x.com/home four times running while
    # document.title stayed "Submit to Reddit". Trusting that reply would have this function read
    # some other site and report a confident answer about the destination.
    for bid in reversed(p_cards()):
        try:
            p_cmd(bid, "navigate", {"url": url})
        except Exception:
            continue
        for wait in (2.0, 3.0, 4.0, 5.0):
            time.sleep(wait)
            try:
                r = p_cmd(bid, "evaluate", {"expression": AUDIT_EXPR})
            except Exception:
                continue
            try:
                v = json.loads(str(r.get("text") or ""))
            except ValueError:
                continue
            landed = (urlparse(str(v.get("u") or "")).hostname or "").lower().replace("www.", "")
            body = str(v.get("body") or "")
            # The URL is the load-bearing half. A body with no host check is a page we cannot name.
            if not body or (want_host and landed != want_host):
                continue
            saw_page = True
            if marker in body:
                return True
        if saw_page:
            break
    return False if saw_page else None


# One expression, so what counts as "the page" is defined in exactly one place. innerText only:
# innerHTML would match the marker inside a hidden template or a JSON blob the site ships, and a
# post nobody can see is not a post that landed.
AUDIT_EXPR = ('(()=>{try{return {body:(document.body&&document.body.innerText)||"",'
              'u:location.href};}catch(e){return {body:"",u:""};}})()')


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
    audit_url = cfg["audit"].format(handle=handle)
    r = run_task(cfg["post"].format(m=marker, handle=handle), f"canary-post-{site}", keep=True)
    log = str(r["log"])
    sid = str(r["sid"])
    res["post_wall"] = r["wall"]
    # A run whose log slice is EMPTY was not observed, and the receipt question cannot be answered
    # about it either way. Saying "no receipt" there charges the product for the harness pointing at
    # the wrong file, which is exactly what happened: OSW_CANARY_LOG named a file the backend was no
    # longer writing to, so every LinkedIn round scored a receipt failure with no receipt evidence in
    # the frame at all. Refuse to grade instead.
    if not log.strip():
        teardown(sid)
        res.update(stage="post", ok=False, invalid=True,
                   detail=f"INVALID: no log slice (is OSW_CANARY_LOG={LOG} the live backend's log?)")
        return res
    delivered = any(k in log for k in P_RECEIPT_MARKERS)
    # What the run TOLD the user, kept apart from what the page shows, because the gap between the
    # two is the number that matters. A claim with no evidence under it is a false success, and it
    # cannot be counted at all unless the two are recorded separately.
    said = str(r["said"])
    res["claimed"] = delivered or bool(
        re.search(r"\b(posted|published|tweeted|submitted|sent it|has been posted)\b", said, re.I))
    # Audit through the run's OWN card, before teardown: it is already signed in and on the site.
    proven = marker_in_page(audit_url, marker)
    teardown(sid)
    res["proven"] = proven
    res["false_success"] = bool(res["claimed"]) and proven is False
    if not delivered:
        res.update(stage="post", ok=False,
                   detail=f"no receipt (status={r['status']}, on_page={proven}): {said[:100]}")
        return res
    if proven is False:
        # The receipt fired and the destination does not have it. This is exactly the failure the
        # canary was built for, and it must never be reported as a pass.
        res.update(stage="post", ok=False,
                   detail=f"FALSE SUCCESS: receipt says sent, {marker} is not on the destination")
        return res

    # 2. DELETE, and require the in-page verify-gone, so cleanup can't be claimed falsely. The
    # authority is the OUTCOME (is it still on the page?) and never the implementation detail:
    # grepping for `removed=True`, which only the BrowserDeleteItem dispatch path prints, called
    # DRIFT on a model-driven delete that had plainly worked, twice on X.
    d = run_task(cfg["delete"].format(m=marker, handle=handle), f"canary-clean-{site}", keep=True)
    res["delete_wall"] = d["wall"]
    still_there = marker_in_page(audit_url, marker)
    teardown(str(d["sid"]))
    removed = still_there is False
    res["verified_by"] = {True: "marker still on page", False: "marker absent from raw page text",
                          None: "could not read the destination"}[still_there]
    if not removed:
        res.update(stage="cleanup", ok=False,
                   detail=f"POSTED BUT NOT CLEANED, marker {marker} may be live "
                          f"({res['verified_by']}): {str(d['said'])[:70]}")
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
        # The marker rides on EVERY row, not just the ones that admit trouble. It is the only record
        # of what this run put on a real account: it is never written to the backend log (a grep for
        # every marker ever generated returns nothing), so a row that printed no marker and later
        # turned out to be stranded could not be cleaned up by hand at all.
        print(f"  [{flag}] {s:10} {r.get('marker','')}  stage={r.get('stage','?'):10} "
              f"{r.get('detail','')}", flush=True)

    bad = [r for r in rows if not r.get("ok")]
    stranded = [r for r in bad if r.get("stage") == "cleanup"]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} sites healthy")
    if args.live:
        graded = [r for r in rows if not r.get("invalid")]
        proven = [r for r in graded if r.get("proven") is True]
        unprovable = [r for r in graded if r.get("proven") is None]
        liars = [r for r in graded if r.get("false_success")]
        invalid = [r for r in rows if r.get("invalid")]
        print(f"verified writes: {len(proven)}/{len(graded)} proven on the destination"
              + (f", {len(unprovable)} unprovable (audit read failed)" if unprovable else ""))
        print(f"FALSE SUCCESS CLAIMS: {len(liars)}"
              + (" <- hard gate, must be 0: " + ", ".join(str(r["site"]) for r in liars)
                 if liars else ""))
        # Printed, never folded in. An excluded row is a claim that the product was not on trial,
        # and that claim has to survive being read out loud.
        for r in invalid:
            print(f"  EXCLUDED (not graded): {r['site']} - {r['detail']}")
    if stranded:
        print("!! MANUAL CLEANUP NEEDED: " + ", ".join(f"{r['site']}:{r['marker']}" for r in stranded))
    if bad:
        print("DRIFT DETECTED on: " + ", ".join(str(r["site"]) for r in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
