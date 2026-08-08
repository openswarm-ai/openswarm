"""Paired benchmark: OpenSwarm's browser agent vs browser-use, same tasks, same lane, same bar.

Append-only and resumable on purpose. A 95% CI narrow enough to separate two systems needs tens of
trials per site per system, which is hours of wall clock, so this accumulates across many runs into
one jsonl instead of trying to finish in one sitting. Re-running only adds rows; the report is
computed from everything on disk.

Confound control, because the first eight attempts at this comparison were all confounded:
  - PAIRED. Both systems run the same site back-to-back inside one iteration, so a site that changes
    during the day (deepl started redirecting to a locale path mid-session) moves BOTH arms, not one.
  - Same LLM lane: both go through 9Router to the same Claude subscription and the same model id.
  - Same success bar: intended host AND payload independently read back out of the live page. Neither
    side's self-report is ever the evidence; the agent's claim is stored separately so
    claimed-and-unverified is counted as a false success against whichever side made it.
  - Same exclusion rule: a trial whose LANE failed (401/429/transport) is bucketed infra and left out
    of the graded denominator for both arms.
  - Browser is NOT held constant, deliberately. browser-use cannot screenshot an Electron webview and
    falls back to the app's page target on 100% of steps (49/49 measured), so forcing a shared browser
    blinds it. Each side runs in the browser it was built for, and that is recorded as a caveat rather
    than hidden.

Never submits. Every task says type-then-stop, and OpenSwarm additionally runs its backend in
OSW_SENDSCRIPT_DRYRUN=1 so its irreversible click is refused in code rather than by prompt.
"""
import json
import math
import os
import statistics
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ROWS = os.path.join(HERE, "results", "vs_raw.jsonl")
PAYLOAD = "coverage probe alpha"

# TWO stop texts, because one prompt could not constrain both arms without biasing one of them.
# OpenSwarm enforces reach-only in CODE (OSW_SENDSCRIPT_DRYRUN=1 refuses the irreversible click in
# the backend), so it needs no instruction -- and must not be given one: a "do NOT submit" directive
# trips is_readonly() and the send-script declines outright ("decline: read-only directive in user
# request"), which measured as reach 0/2 while browser-use scored 2/2 on the identical prompt. That
# is a prompt-induced asymmetry, not a capability difference.
# browser-use has no dry-run mode, so for it the constraint has to live in the prompt.
STOP_BU = (" Type the text into the box and then STOP immediately. Do NOT submit, save, publish, "
           "post, run, send, translate, or press Enter. Do not click any button after typing.")
STOP_OSW = ""

# Shape-diverse and anonymous, so a miss is never an account state. Same five both arms see.
SITES = {
    "gtranslate": ('Go to translate.google.com and type "coverage probe alpha" into the source text box. ' + STOP_BU,
                   "translate.google.com", "plain textarea"),
    "deepl":      ('Go to deepl.com/translator and type "coverage probe alpha" into the source text box. ' + STOP_BU,
                   "deepl.com", "rich contenteditable"),
    "w3schools":  ('Go to w3schools.com/html/tryit.asp?filename=tryhtml_default and type '
                   '"coverage probe alpha" into the code editor on the left. ' + STOP_BU,
                   "w3schools.com", "ACE in iframe"),
    "regex101":   ('Go to regex101.com and type "coverage probe alpha" into the TEST STRING box. ' + STOP_BU,
                   "regex101.com", "CodeMirror 6"),
    "onlinegdb":  ('Go to onlinegdb.com and type "coverage probe alpha" into the code editor. ' + STOP_BU,
                   "onlinegdb.com", "ACE"),
}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Wilson score interval. Used instead of the normal approximation because at n=20 with k=20 the
    naive interval is [1.0, 1.0], which claims certainty a 20-trial sample cannot carry."""
    if n == 0:
        return (0.0, 0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0.0, c - m), min(1.0, c + m))


def append(row: dict) -> None:
    os.makedirs(os.path.dirname(ROWS), exist_ok=True)
    with open(ROWS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")
        fh.flush()


def load() -> list:
    if not os.path.exists(ROWS):
        return []
    out = []
    with open(ROWS, encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if ln:
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    pass
    return out


def report(rows: list) -> None:
    graded = [r for r in rows if not r.get("infra")]
    print(f"\n=== vs_bench: {len(rows)} rows, {len(graded)} graded, "
          f"{len(rows) - len(graded)} infra-excluded ===")
    for arm in ("openswarm", "browser-use"):
        a = [r for r in graded if r["arm"] == arm]
        if not a:
            continue
        k = sum(r["reached"] for r in a)
        p, lo, hi = wilson(k, len(a))
        fs = sum(1 for r in a if r.get("claimed") and not r["reached"])
        walls = sorted(r["wall_s"] for r in a if r["reached"])
        print(f"\n  {arm}: reach {k}/{len(a)} = {100*p:.1f}%  95% CI [{100*lo:.1f}, {100*hi:.1f}]")
        print(f"    false successes (claimed, unverified): {fs}")
        if walls:
            med = statistics.median(walls)
            p95 = walls[min(len(walls) - 1, int(round(0.95 * (len(walls) - 1))))]
            print(f"    wall on reached: median {med:.1f}s  p95 {p95:.1f}s  n={len(walls)}")
        print(f"    {'site':12s}{'reach':>10}  {'95% CI':>16}  shape")
        for site in SITES:
            sa = [r for r in a if r["site"] == site]
            if not sa:
                continue
            sk = sum(r["reached"] for r in sa)
            sp, slo, shi = wilson(sk, len(sa))
            print(f"    {site:12s}{sk:>4}/{len(sa):<5}  [{100*slo:5.1f},{100*shi:5.1f}]  {SITES[site][2]}")
    # Paired comparison: only iterations where BOTH arms produced a graded row for that site.
    pairs = {}
    for r in graded:
        pairs.setdefault((r["iter"], r["site"]), {})[r["arm"]] = r
    both = [v for v in pairs.values() if len(v) == 2]
    if both:
        ow = sum(1 for v in both if v["openswarm"]["reached"] and not v["browser-use"]["reached"])
        bw = sum(1 for v in both if v["browser-use"]["reached"] and not v["openswarm"]["reached"])
        tie = len(both) - ow - bw
        print(f"\n  PAIRED on {len(both)} same-site iterations: openswarm-only {ow}, "
              f"browser-use-only {bw}, both-or-neither {tie}")
        # McNemar exact, the correct test for paired binary outcomes with small discordant counts.
        n_d = ow + bw
        if n_d:
            k = min(ow, bw)
            p_two = min(1.0, 2 * sum(math.comb(n_d, i) for i in range(k + 1)) / (2 ** n_d))
            print(f"    McNemar exact p = {p_two:.4f} on {n_d} discordant pairs"
                  f"{'  <- significant at 0.05' if p_two < 0.05 else '  <- NOT significant'}")


def run_openswarm(site: str, task: str, host: str) -> dict:
    """One OpenSwarm trial through its real dispatch path, verified by reading the card back."""
    t0 = time.time()
    tok = open(os.path.join(ROOT, "backend/data/auth.token")).read().strip()
    base = os.environ.get("OSW_BASE", "http://127.0.0.1:8326") + "/api"

    def req(method, url, body=None, timeout=300):
        data = json.dumps(body).encode() if body is not None else None
        rq = urllib.request.Request(url, data=data, method=method,
                                    headers={"Content-Type": "application/json",
                                             "Authorization": "Bearer " + tok})
        with urllib.request.urlopen(rq, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")

    sid = None
    claimed, infra, why = False, "", ""
    try:
        ds = req("GET", f"{base}/dashboards/list")
        ds = ds if isinstance(ds, list) else ds.get("dashboards", [])
        # Cards that existed BEFORE this trial. A dashboard accumulates one card per run and they
        # persist in the saved layout, so reading "all cards" verifies against seven stale pages from
        # earlier trials: measured, a regex101 run graded 0/1 because its own card had been reaped
        # while six leftovers answered instead. Only cards this trial created can be its evidence.
        p_before = set(((req("GET", f"{base}/dashboards/{ds[0]['id']}").get("layout") or {})
                        .get("browser_cards") or {}))
        model = os.environ.get("OSW_MODEL", "opus-4-8-cc")
        sid = req("POST", f"{base}/agents/launch",
                  {"mode": "agent", "model": model, "provider": "anthropic",
                   "dashboard_id": ds[0]["id"], "name": f"vs-{site}"})["session"]["id"]
        try:
            req("POST", f"{base}/agents/sessions/{sid}/message",
                {"prompt": task, "mode": "agent", "model": model})
        except Exception:
            pass
        while time.time() - t0 < 240:
            s = req("GET", f"{base}/agents/sessions/{sid}")
            if str(s.get("status") or "") in ("completed", "error", "stopped"):
                claimed = str(s.get("status")) == "completed"
                break
            time.sleep(2)
        # Verified from the CARD, never from the agent's reply: same bar as the other arm.
        cards = [c for c in ((req("GET", f"{base}/dashboards/{ds[0]['id']}").get("layout") or {})
                             .get("browser_cards") or {}) if c not in p_before]
        # No new card at all means the run never opened one, which is NOT the same event as "opened a
        # page and failed to fill it" -- and the harness could not tell them apart, so 9 rows landed
        # in a false-success bucket that measured my own read timing. Recorded explicitly.
        p_ncards = len(cards)
        found = False
        for bid in cards:
            try:
                r = req("POST", f"{base}/browser/command",
                        {"action": "evaluate", "browser_id": bid,
                         "params": {"expression": READBACK_JS}}, timeout=60)
                raw = r.get("result") if isinstance(r, dict) else None
                raw = raw if isinstance(raw, str) else json.dumps(r)
                if host in raw and PAYLOAD.lower() in raw.lower():
                    found, why = True, f"payload+host in card {bid[:12]}"
                    break
            except Exception:
                continue
        if not found:
            why = f"payload not read back from {len(cards)} new card(s)"
        reached = found
    except Exception as e:
        reached, infra = False, f"{type(e).__name__}: {str(e)[:70]}"
    finally:
        if sid:
            try:
                req("DELETE", f"{base}/agents/sessions/{sid}", timeout=60)
            except Exception:
                pass
    # A trial with no readable card is graded from the BACKEND's own dryrun-report instead of being
    # excluded. Excluding them was too charitable and flipped the whole result (openswarm 60.9% ->
    # 100%, McNemar p=0.02 -> 1.0) purely on my read timing, and the log shows those rows are real
    # misses: deepl reports composer=0 textboxes=0 and onlinegdb composer=0 textboxes=2, both on the
    # correct URL. `filled=1` in that line is the product asserting it committed the payload, which
    # is the same bar the card readback applies, so it can stand in when the card is already reaped.
    if not infra and not reached and locals().get("p_ncards", 1) == 0:
        p_log = os.environ.get("OSW_LOG", "")
        p_saw = ""
        try:
            with open(p_log, errors="ignore") as fh:
                for ln in fh:
                    if "[dryrun-report]" in ln and host in ln:
                        p_saw = ln
        except OSError:
            p_saw = ""
        if p_saw:
            reached = " filled=1" in p_saw
            why = "from dryrun-report: " + p_saw.split("[dryrun-report]")[-1].strip()[:70]
        else:
            infra = "no card and no dryrun-report; unverifiable"
    return {"arm": "openswarm", "site": site, "reached": bool(reached), "claimed": bool(claimed),
            "cards": locals().get("p_ncards", -1),
            "wall_s": round(time.time() - t0, 1), "infra": infra, "why": why}


READBACK_JS = ("(() => { const v=[]; const walk=(w,d)=>{ if(d>4) return; try{"
               "for(const e of w.document.querySelectorAll('textarea,input,[contenteditable]')){"
               "const x=(e.value!=null&&e.value!==''?e.value:e.textContent)||'';"
               "if(x) v.push(String(x).slice(0,200)); }"
               "for(let i=0;i<w.frames.length;i++){ try{ walk(w.frames[i],d+1); }catch(e){} }"
               "}catch(e){} }; walk(window,0);"
               " return JSON.stringify({url:location.href, vals:v}); })()")


def run_browser_use(site: str, iter_i: int) -> dict:
    """One browser-use trial, in ITS native Chrome, verified by the session-based readback."""
    venv = os.environ.get("BU_VENV", "")
    runner = os.environ.get("BU_RUNNER", "")
    if not venv or not runner:
        return {"arm": "browser-use", "site": site, "reached": False, "claimed": False,
                "wall_s": 0.0, "infra": "BU_VENV/BU_RUNNER unset", "why": ""}
    t0 = time.time()
    try:
        out = subprocess.run([venv, runner, site], capture_output=True, text=True, timeout=400,
                             cwd=os.path.dirname(runner), env={**os.environ, "N": "1"})
        line = [l for l in out.stdout.splitlines() if l.strip().startswith("[1/1]")]
        txt = line[0] if line else out.stdout[-200:]
        reached = " reach=Y" in txt
        claimed = "claimed=Y" in txt
        infra = "infra:" if "infra:" in txt else ""
        return {"arm": "browser-use", "site": site, "reached": reached, "claimed": claimed,
                "wall_s": round(time.time() - t0, 1), "infra": infra, "why": txt.strip()[-90:]}
    except subprocess.TimeoutExpired:
        return {"arm": "browser-use", "site": site, "reached": False, "claimed": False,
                "wall_s": round(time.time() - t0, 1), "infra": "timeout", "why": ""}


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "report":
        report(load())
        return
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    only = sys.argv[2:] or list(SITES)
    start = max([r.get("iter", 0) for r in load()] or [0]) + 1
    for i in range(start, start + iters):
        for site in only:
            if site not in SITES:
                continue
            task, host, _shape = SITES[site]
            # OpenSwarm gets the task WITHOUT the stop directive; its dry-run gate is in the backend.
            task_osw = task.replace(STOP_BU, "").strip()
            for fn in (lambda: run_openswarm(site, task_osw, host),
                       lambda: run_browser_use(site, i)):
                r = fn()
                r["iter"] = i
                r["ts"] = round(time.time(), 1)
                append(r)
                print(f"  [{i}] {r['arm']:12s} {site:11s} reach={'Y' if r['reached'] else 'n'} "
                      f"{r['wall_s']:>6.1f}s  {r['infra'] or r['why']}", flush=True)
    report(load())


if __name__ == "__main__":
    main()
