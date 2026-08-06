"""Write-path coverage across sites with a GENUINE session, measured in dry run.

Reports the two halves separately, because they fail for different reasons and only one of them was
ever instrumented: did we REACH a composer and commit a fill, and can we RESOLVE that composer's
submit. The second half is new. Without it every sweep said "ready to send" about sends that would
have blind-tapped a coordinate (reddit, live).

Never posts: the backend runs with OSW_SENDSCRIPT_DRYRUN=1, which stops at the irreversible click.
"""
import json, os, re, sys, time, urllib.request

# Repo root, derived from this file (e2e/browser-v3/x.py -> two levels up). Hardcoding an
# absolute path made this harness silently useless on any other checkout.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.environ.get("OSW_BASE", "http://127.0.0.1:8326") + "/api/agents"
LOG  = os.environ.get("OSW_LOG", "")
MODEL = "opus-4-8"

# This list was captioned "only sites this profile is genuinely signed into" and that was not true:
# gmail and substack hit a login wall on every single sweep, and their rows were scored as composer
# misses, which quietly charged our code for an account state. Sign-in is re-derived per run now,
# from the page's own evidence, and an unmeasurable site leaves the denominator instead of losing.
TASKS = {
  "x":         'Go to x.com and post this tweet, exactly: "coverage probe alpha"',
  "linkedin":  'Go to linkedin.com and create a post with exactly this text: "coverage probe alpha"',
  "reddit":    'Go to reddit.com/r/test/submit and create a text post with body "coverage probe alpha"',
  "gmail":     'Go to gmail and start a new email with the body "coverage probe alpha"',
  "youtube":   'Go to youtube.com, open the first video, and write the comment "coverage probe alpha"',
  "instagram": 'Go to instagram.com and write a comment "coverage probe alpha" on the first post',
  "tiktok":    'Go to tiktok.com and write a comment "coverage probe alpha" on the first video',
  "substack":  'Go to substack.com and start a new note with the text "coverage probe alpha"',
  "twitch":    'Go to twitch.tv, open the first live channel, and write "coverage probe alpha" in chat',
}

def req(method, url, body=None):
    tok = open(os.path.join(ROOT, "backend/data/auth.token")).read().strip()
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read().decode() or "{}")

def loglines():
    try: return sum(1 for _ in open(LOG, errors="ignore"))
    except OSError: return 0

BACKEND_DOWN = "[harness] BACKEND UNREACHABLE"


def run(site, prompt, budget=200):
    mark = loglines()
    # A dead backend used to raise URLError straight out of here and kill the whole sweep mid-run,
    # losing every trial after it. It is also not a product failure and must never be graded as one,
    # so it gets a marker the classifier can bucket as infrastructure.
    try:
        dash = req("GET", BASE.replace("/agents","") + "/dashboards/list")
        ds = dash if isinstance(dash, list) else dash.get("dashboards", [])
        sid = req("POST", f"{BASE}/launch", {"mode":"agent","model":MODEL,"provider":"anthropic",
                  "dashboard_id": ds[0]["id"], "name": f"cov-{site}"})["session"]["id"]
    except Exception as e:
        time.sleep(20)   # give the supervisor a chance to bring it back before the next trial
        return f"{BACKEND_DOWN} ({type(e).__name__}: {str(e)[:80]})", 0.0
    t0 = time.time()
    try: req("POST", f"{BASE}/sessions/{sid}/message", {"prompt":prompt,"mode":"agent","model":MODEL})
    except Exception: pass
    while time.time() - t0 < budget:
        try:
            s = req("GET", f"{BASE}/sessions/{sid}")
            if str(s.get("status") or "") in ("completed","error","stopped"): break
        except Exception: pass
        time.sleep(2)
    time.sleep(1.5)
    try: sl = "".join(open(LOG, errors="ignore").readlines()[mark:])
    except OSError: sl = ""
    # Tear the trial down before the next one starts. Each run leaves a chat session and a live
    # browser card with its own webview; across 45 runs that is 45 webviews the renderer keeps
    # compositing, and a starved renderer stops answering, which reads as a product failure. It
    # already cost one whole sweep (24 of 45 rows came back "no dashboard" and scored a meaningless
    # 29%). delete_session stops the browser-agent children first, so this reaps the cards too.
    # Read the log slice BEFORE deleting, or the teardown's own lines land in the graded window.
    try: req("DELETE", f"{BASE}/sessions/{sid}")
    except Exception: pass
    return sl, round(time.time()-t0, 1)

DRY = re.compile(r"DRYRUN: WOULD send \(fill committed, send_button_listed=(\w+), "
                 r"submit_resolved=(\w+), submit_rank=(\d+), submit=(.+?)\); not clicking")
DECL = re.compile(r"\[browser-sendscript\] decline: (.+)")
DISABLED = re.compile(r"submit (.+?) is present but DISABLED")
FILL = re.compile(r"\[browser-sendscript\] fill target (.+?) \[(-?\d+)\] on (\S*)")
# The composer was found AND focused and the text still would not go in. The old grader printed
# "no send-script activity" for this, which reads as "nothing happened", and it hid the twitch and
# instagram failures for as long as they existed. A dead fill is a code gap, and it gets a name.
FILLERR = re.compile(r"fill errored \((.+?)\); handing")
# Signed out, judged on the page's OWN evidence rather than on the product's label: a sign-in URL
# or a visible password field. Grading this with the product's verdict would be grading the guard
# with the guard, which is the mistake that made every earlier number worthless.
WALL = re.compile(r"decline: login/auth wall \('([^']*)'\)(?: triggered by (url|password field))?")
SIGNIN_URL = re.compile(r"(accounts\.google\.com|/login|/signin|/sign[-_]?in|/i/flow/login|/auth/)", re.I)
# Matched on the page's own words, not on the product's verdict, same rule as everything else here.
CAPTCHA = re.compile(
    r"enter (?:the )?(?:code|characters) you hear|play the audio|press (?:and|&) hold|"
    r"drag (?:the )?(?:slider|puzzle)|i'?m not a robot|verify you are (?:a )?human|"
    r"select all (?:images|squares) (?:with|containing)|recaptcha|hcaptcha|turnstile|"
    r"bot-detection challenge",
    re.I)
SAYS_OUT = "decline: signed OUT"

# The page each task must end up on, written out by hand from what these sites actually use. This
# is the half the harness was missing: it scored "a composer got filled" and never asked whose.
# The instagram DM that started all this was filled on instagram.com/<someone>/, a PROFILE, while
# the task said "the first post". The URL alone rejects it, and unlike a name check it still works
# when the structural finder reports its box as a bare 'contenteditable'.
ON_PAGE = {
  "x":         r"x\.com/(home|compose)",
  "linkedin":  r"linkedin\.com/(feed|posts)",
  "reddit":    r"reddit\.com/r/[^/]+/submit",
  "gmail":     r"mail\.google\.com/",
  "youtube":   r"youtube\.com/watch",
  "instagram": r"instagram\.com/(p|reel)/",
  "tiktok":    r"tiktok\.com/@[^/]+/video/",
  "substack":  r"substack\.com/",
  "twitch":    r"twitch\.tv/[^/?]+(/|\?|$)",
}
# Graded independently of the product's own surface_mismatch on purpose: grading the guard with the
# guard proves nothing. These are the names a DM box carries on the sites above.
DM_NAME = re.compile(r"\b(message|messages|dm)\b", re.I)
PUBLIC = ("x", "linkedin", "reddit", "youtube", "instagram", "tiktok", "substack")

# A dry run can never actually send, so the completion gate correctly calls EVERY run a ghost
# ("declared done but the send was not confirmed") and the fast path fires one recovery dispatch.
# That recovery reuses the same card, wherever it has drifted to, and fills whatever it finds. Those
# fills are an artifact of measuring in dry run and say nothing about coverage. Scoring them made
# reddit and youtube look systematically broken (3/3 and 2/2 "wrong page") when both had already hit
# the right composer seconds earlier: reddit on /r/test/submit, youtube on /watch.
RECOVERY = "one recovery dispatch"

def gradeable(slice_):
    """The part of the run that happened before dry-run recovery muddied it."""
    cut = slice_.find(RECOVERY)
    return slice_[:cut] if cut > 0 else slice_

def last(rx, slice_):
    """A run can legitimately fill more than once (reddit tries /r/test/submit, then bare /submit),
    so the LAST attempt inside the gradeable window owns the verdict; taking the first scored a page
    the run had already left."""
    ms = list(rx.finditer(gradeable(slice_)))
    return ms[-1] if ms else None

def surface(site, slice_):
    """(ok, description) for the box that actually got filled. ok=False means we reached SOMETHING,
    which the old harness counted as a win, and it was the wrong thing."""
    f = last(FILL, slice_)
    if not f:
        return None, ""
    name, url = f.group(1), f.group(3)
    if site in PUBLIC and DM_NAME.search(name):
        return False, f"DM box {name} on {url[:44]}"
    want = ON_PAGE.get(site)
    if want and not re.search(want, url):
        return False, f"wrong page {url[:52]}"
    return True, f"{name} on {url[:40]}"

# A run whose LLM lane was flapping underneath it measured the machine, not the write path. Every
# one of these was live in the 2026-08-01 sweep, which scored 1/9 while nothing about the code had
# changed: eight other OpenSwarm backends were on the box, each one's dev logic killing the shared
# 9router and starting its own on :20128. Wall times went 30s -> 202s and prestage got skipped.
# "prestage] skipped" used to be in this list bare, and that was too wide: prestage skips for CODE
# reasons too, and a live run on twitch died with "'utf-8' codec can't encode '\ud83e'" (half an
# emoji) which this harness then filed as an environment problem and told me to re-run. A real bug
# wearing an INVALID badge is worse than no harness. Only provider-shaped reasons count as sick.
UNHEALTHY = ("9Router watchdog", "9Router process died", "No AI provider connected",
             "prestage] skipped (No AI provider", "prestage] skipped (classifier",
             "dispatch refused: no dashboard")

def row(**kw):
    base = {"composer": False, "reached": False, "submit": False, "rank": 0,
            "invalid": False, "unmeasurable": "", "detail": ""}
    base.update(kw)
    return base

def unmeasurable(slice_):
    """Why this run could not measure our code at all, or '' if it could.

    Being signed out is an account state, not a coverage failure, and charging our code for it is
    how gmail and substack sat in the miss column across five sweeps. Read the page's own evidence
    (a sign-in URL, a visible password field), and when the only thing available is the agent's own
    say-so, return it labelled UNVERIFIED so it can never be quietly banked as a clean excuse.
    """
    # A bot-detection challenge is not a coverage failure. Solving one is off-limits, so a page
    # behind a captcha is a page our code is not allowed to reach, and scoring it against reach
    # charges us for a rule we are choosing to keep. Eric caught this on tiktok: an audio captcha
    # over a logged-out feed, while the row read "no composer" as though the finder had missed.
    cap = CAPTCHA.search(slice_)
    if cap:
        return f"bot-detection challenge, PROVEN ({cap.group(0)[:44]})"
    w = WALL.search(slice_)
    if w:
        url, trigger = w.group(1), w.group(2) or ""
        if trigger == "password field":
            return f"signed out, PROVEN (password field on {url[:38]})"
        if SIGNIN_URL.search(url):
            return f"signed out, PROVEN (sign-in URL {url[:42]})"
        return f"login wall claimed, UNVERIFIED (no evidence for {url[:34]})"
    if SAYS_OUT in slice_:
        return "signed out per the agent, UNVERIFIED (no wall evidence)"
    return ""

def verdict(site, slice_):
    sick = [s for s in UNHEALTHY if s in slice_]
    if sick:
        return row(invalid=True, detail=f"INVALID: stack was unhealthy ({sick[0]})")
    ok, where = surface(site, slice_)
    reached = ok is not None
    # The harness prompts a PARENT agent, which rewrites the task for the browser sub-agent. When
    # that rewrite happens to quote two different strings the send script honestly declines, and
    # that is the harness's phrasing failing, not this site's coverage. Scoring it as a miss put
    # x at "n" on a run where x was fine 4 minutes earlier. Call it INVALID and re-run the site.
    if not reached and "no unambiguous quoted payload" in slice_:
        return row(invalid=True, detail="INVALID: parent rephrased the task, payload came through ambiguous")
    why = unmeasurable(slice_)
    if why and not reached:
        return row(unmeasurable=why, detail=f"NOT MEASURABLE: {why}")
    if ok is False:
        return row(reached=True, detail=f"WRONG SURFACE: {where}")
    m = last(DRY, slice_)
    d = DISABLED.search(slice_)
    if m or d:
        submit = bool(m) and m.group(2) == "True"
        rank = int(m.group(3)) if m else 0
        detail = (m.group(4)[:34] if m else f"DISABLED {d.group(1)[:24]}")
        return row(composer=True, reached=reached, submit=submit, rank=rank,
                   detail=f"{detail} <- {where}")
    # Reached the right box, focused it, and the text would not go in. Its own column: this is the
    # one failure mode a better composer finder cannot fix, and it was invisible until now.
    fe = last(FILLERR, slice_)
    if fe:
        return row(reached=True, detail=f"FILL DIED on {where}: {fe.group(1)[:46]}")
    c = DECL.findall(slice_)
    return row(reached=reached,
               detail=("decline: " + c[-1][:46]) if c else "no send-script activity")

def preflight():
    """Refuse to measure on a box that cannot hold still. One 9router serves :20128 and every dev
    backend's startup kills the one it does not own, so a second stack anywhere on the machine turns
    this sweep into a coin flip. Better to print why than to publish a number that means nothing."""
    import subprocess
    # Count the real interpreters only. `pgrep -f "uvicorn backend.main"` also matches the
    # supervising shell (its command line quotes the whole uvicorn line), so with a supervisor in
    # place this refused to run every single time, on a box holding exactly one backend.
    ps = subprocess.run(["ps", "-Ao", "command"], capture_output=True, text=True).stdout
    n = sum(1 for ln in ps.splitlines()
            if "-m uvicorn backend.main" in ln and "/bin/python" in ln)
    router = urllib.request.urlopen("http://127.0.0.1:20128/v1/models", timeout=5).status
    if n > 1 or router != 200:
        print(f"REFUSING: {n} backends on this box (want 1), 9router HTTP {router} (want 200).")
        print("Another session's stack is fighting yours for the router. Wait it out.")
        sys.exit(2)

if __name__ == "__main__":
    if os.environ.get("OSW_SKIP_PREFLIGHT") != "1":
        preflight()
    only = sys.argv[1:] or list(TASKS)
    rows = []
    for site in only:
        if site not in TASKS: continue
        sl, wall = run(site, TASKS[site])
        v = verdict(site, sl); v["site"] = site; v["wall"] = wall
        rows.append(v)
        print(f"  {site:11s} composer={'Y' if v['composer'] else 'n'} "
              f"submit={'Y' if v['submit'] else 'n'} rank={v['rank']} {wall:6.1f}s  {v['detail']}", flush=True)
    invalid = [r for r in rows if r["invalid"]]
    unmeas = [r for r in rows if r["unmeasurable"] and not r["invalid"]]
    graded = [r for r in rows if not r["invalid"] and not r["unmeasurable"]]
    n = len(graded)
    wrong = sum("WRONG SURFACE" in r["detail"] for r in graded)
    died = sum("FILL DIED" in r["detail"] for r in graded)
    print(f"\n=== RIGHT composer {sum(r['composer'] for r in graded)}/{n} measurable | "
          f"submit resolved {sum(r['submit'] for r in graded)}/{n} | "
          f"WRONG surface {wrong} | fill DIED {died} ===")
    # Printed, never folded in. An excluded row is a claim that our code was not on trial, and that
    # claim has to survive being read out loud, especially the ones resting on the agent's own word.
    for label, group in (("NOT MEASURABLE", unmeas), ("INVALID, re-run", invalid)):
        for r in group:
            print(f"  {label}: {r['site']} ({r['unmeasurable'] or r['detail']})")
    shaky = [r["site"] for r in unmeas if "UNVERIFIED" in r["unmeasurable"]]
    if shaky:
        print(f"  ^ {', '.join(shaky)} rest on the agent's own word. Confirm by hand before quoting "
              f"any number that leaves them out.")
    json.dump(rows, open(os.environ.get("OSW_OUT","/tmp/cov.json"), "w"), indent=1)
