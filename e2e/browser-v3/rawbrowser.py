"""Drive a browser card directly, with no model anywhere in the loop.

The audit channel the canary now uses, exposed as a CLI so I can check a real account by hand
without hand-escaping JS through three layers of shell quoting (which silently sent a mangled
expression once and made a working navigate look like a domain-gate refusal).

    rawbrowser.py cards
    rawbrowser.py read  <url> [substring]
    rawbrowser.py eval  <url> <js>
"""

import json
import os
import sys
import time
import urllib.request
from urllib.parse import urlparse

# Repo root, derived from this file (e2e/browser-v3/x.py -> two levels up). Hardcoding an
# absolute path made this harness silently useless on any other checkout.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = os.environ.get("OSW_BASE", "http://127.0.0.1:8326") + "/api"


def req(method, url, body=None):
    tok = open(os.path.join(ROOT, "backend/data/auth.token")).read().strip()
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json",
                                        "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(r, timeout=180) as resp:
        return json.loads(resp.read().decode() or "{}")


def cards():
    ds = req("GET", f"{API}/dashboards/list")
    ds = ds if isinstance(ds, list) else ds.get("dashboards", [])
    if not ds:
        return []
    full = req("GET", f"{API}/dashboards/{ds[0]['id']}")
    return list(((full.get("layout") or {}).get("browser_cards") or {}))


def cmd(bid, action, params):
    return req("POST", f"{API}/browser/command",
               {"action": action, "browser_id": bid, "params": params})


BODY = ('(()=>{try{return {body:(document.body&&document.body.innerText)||"",'
        'u:location.href};}catch(e){return {body:"",u:""};}})()')


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "cards"
    cs = cards()
    if what == "cards":
        print("\n".join(cs) or "(none)")
        return 0
    if not cs:
        print("no browser card on the dashboard; run a browser task first")
        return 2
    url = sys.argv[2]
    want = (urlparse(url).hostname or "").lower().replace("www.", "")
    # A card whose session was torn down mid-run WEDGES: it answers navigate with "Navigated to
    # <url>" in ~80ms and stays where it was. So never trust the reply, check where we landed, and
    # move to another card if this one did not go.
    bid = ""
    for cand in ([os.environ["OSW_CARD"]] if os.environ.get("OSW_CARD") else list(reversed(cs))):
        cmd(cand, "navigate", {"url": url})
        time.sleep(float(os.environ.get("OSW_SETTLE", "5")))
        got = cmd(cand, "evaluate", {"expression": BODY})
        try:
            landed = json.loads(got.get("text") or "{}").get("u") or ""
        except ValueError:
            landed = ""
        if (urlparse(landed).hostname or "").lower().replace("www.", "") == want:
            bid = cand
            break
        print(f"[card {cand} wedged, landed on {landed[:60]!r}]", file=sys.stderr)
    if not bid:
        print(f"no card could reach {url}", file=sys.stderr)
        return 3
    if what == "eval":
        print(json.dumps(cmd(bid, "evaluate", {"expression": sys.argv[3]}), indent=1))
        return 0
    r = cmd(bid, "evaluate", {"expression": BODY})
    v = json.loads(r.get("text") or "{}")
    body = str(v.get("body") or "")
    print(f"[url] {v.get('u')}\n[chars] {len(body)}")
    if len(sys.argv) > 3:
        needle = sys.argv[3]
        print(f"[{needle!r} present] {needle in body}")
    print(body[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
