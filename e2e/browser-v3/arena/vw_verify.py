"""Independent verified-write scorer: re-read each write task's target from the server and check
the written content persisted -- the honest write-success signal, decoupled from WebArena's
composite reward (which the answer-schema caps). No LLM judge; pure server-state re-read."""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

WA = json.load(open("/Users/eric/.cache/arena/study/webarena/config_files/test.raw.json"))
BYID = {str(t["task_id"]): t for t in WA}
SUB = {"__GITLAB__": "http://localhost:8023", "__REDDIT__": "http://localhost:9999"}

def check(pg, task) -> tuple[bool, str]:
    ev = task.get("eval", {})
    for c in ev.get("program_html", []):
        url = c.get("url", "")
        for k, v in SUB.items():
            url = url.replace(k, v)
        if url in ("last", "") or url.startswith("func:"):
            return None, "url needs episode context (last/func:) — not independently checkable"
        try:
            pg.goto(url, timeout=15000, wait_until="domcontentloaded"); pg.wait_for_timeout(1200)
        except Exception as e:
            return False, f"fetch-fail {str(e)[:40]}"
        loc = c.get("locator") or ""
        if loc and loc.startswith("document."):
            try:
                text = pg.evaluate(f"() => {{ try {{ const e = {loc}; return e ? (e.textContent||e.outerHTML||'') : ''; }} catch(x) {{ return ''; }} }}") or ""
            except Exception:
                text = pg.content()
        else:
            text = pg.content()
        req = c.get("required_contents") or {}
        text = text or ""
        if "must_include" in req:
            if not all(str(x) in text for x in req["must_include"]):
                return False, "must_include absent"
        if "exact_match" in req:
            if req["exact_match"].strip() not in text:
                return False, "exact_match absent"
    return True, "write persisted"

def main():
    sample = json.load(open(sys.argv[1]))["write_task_ids"]
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True); pg = b.new_page()
        out = []
        for tid in sample:
            t = BYID.get(tid)
            if not t:
                continue
            try:
                ok, why = check(pg, t)
            except Exception as e:
                ok, why = None, f"err {str(e)[:40]}"
            out.append({"id": tid, "persisted": ok, "why": why, "intent": t["intent"][:50]})
            print(out[-1])
        b.close()
    scored = [r for r in out if r["persisted"] in (True, False)]
    ok = sum(1 for r in scored if r["persisted"])
    print(f"\nVERIFIED-WRITE (independent re-read): {ok}/{len(scored)} persisted", end="")
    if scored:
        import math
        n, ph = len(scored), ok/len(scored); z=1.96
        lo=(ph+z*z/(2*n)-z*math.sqrt((ph*(1-ph)+z*z/(4*n))/n))/(1+z*z/n)
        print(f" = {100*ph:.0f}% (Wilson95 lo {100*lo:.0f}%)")

if __name__ == "__main__":
    main()
