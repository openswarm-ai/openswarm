"""v3 benchmark: N trials per site, structured traces, honest denominators.

Two things this does that the old sweep did not.

1. N trials. One run per site is noise: on 2026-08-02 x went 2-of-3 and instagram 1-of-3, and a
   single-run number would have called either one whatever the last run happened to be.
2. It separates INFRASTRUCTURE failure from PRODUCT failure and publishes both. A router death is
   not a coverage miss, and hiding it inflates the score; calling a real bug "infrastructure" is the
   mistake that hid the surrogate crash for a whole session. Every attempt lands in the raw file.

Timings come from browser_metrics/tasks.jsonl (the wall/llm/tools/other split), not from log
scraping, because the wall clock cannot tell "our code got faster" from "the model took fewer turns".

Grading is imported from coverage.py, never reimplemented. Two graders would drift and the harness
would start lying again in a new way.
"""
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# coverage.py sits BESIDE this file. Pointing one directory higher was a live trap rather than a
# typo: PyPI ships a package called `coverage` (the code-coverage tool), so on any machine that has
# it installed `import coverage` would quietly bind to that instead of the grader, and every verdict
# would come from a module that has never heard of a composer. Insert this directory FIRST.
sys.path.insert(0, HERE)
import coverage as C  # noqa: E402  the ONE grader

assert hasattr(C, "TASKS"), f"imported the wrong 'coverage' module: {C.__file__}"

ROOT = os.path.dirname(os.path.dirname(HERE))
METRICS = os.path.join(ROOT, "backend/data/browser_metrics/tasks.jsonl")

# Frozen 2026-08-02 at HEAD 1508e03c, before any site-specific v3 work. See HOLDOUT_FROZEN.md.
# Reach only, dry run, never submitted: these are not the user's accounts.
HOLDOUT = {
    "bsky":      'Go to bsky.app and create a post with exactly this text: "coverage probe alpha"',
    "mastodon":  'Go to mastodon.social and create a post with exactly this text: "coverage probe alpha"',
    "devto":     'Go to dev.to and start a new post with the body "coverage probe alpha"',
    "lobsters":  'Go to lobste.rs and start a new story with the text "coverage probe alpha"',
    "pastebin":  'Go to pastebin.com and create a new paste with the text "coverage probe alpha"',
    "discourse": 'Go to meta.discourse.org and start a new topic with the body "coverage probe alpha"',
}
HOLDOUT_PAGE = {
    "bsky":      r"bsky\.app",
    "mastodon":  r"mastodon\.social",
    "devto":     r"dev\.to/new",
    "lobsters":  r"lobste\.rs/stories/new",
    "pastebin":  r"pastebin\.com",
    "discourse": r"discourse\.org",
}
# Addendum, frozen at HEAD ab898964 before its first run. The six above are mostly signed out and
# therefore unscoreable; these publish a composer to anonymous users, so a failure is always OUR
# failure and never a session state. 4 plain textareas + 2 contenteditable rich editors, because a
# holdout of only rich editors would flatter a suite whose wins are nearly all contenteditable.
HOLDOUT.update({
    "rentry":    'Go to rentry.co and create a paste with the text "coverage probe alpha"',
    "dpaste":    'Go to dpaste.org and create a paste with the text "coverage probe alpha"',
    "controlc":  'Go to controlc.com and create a paste with the text "coverage probe alpha"',
    "txti":      'Go to txti.es and create a page with the text "coverage probe alpha"',
    "justpaste": 'Go to justpaste.it and create a note with the text "coverage probe alpha"',
    "telegraph": 'Go to telegra.ph and create a page with the text "coverage probe alpha"',
})
HOLDOUT_PAGE.update({
    "rentry":    r"rentry\.co",
    "dpaste":    r"dpaste\.org",
    "controlc":  r"controlc\.com",
    "txti":      r"txti\.es",
    "justpaste": r"justpaste\.it",
    "telegraph": r"telegra\.ph",
})

# Infrastructure, not coverage. Kept separate and PUBLISHED, never folded into either column.
INFRA = (
    # The backend itself. It has died mid-sweep on a clean SIGTERM with nothing in its log
    # (2026-08-05), and an unnoticed death turns every following trial into a fake product failure.
    # `BACKEND RESTARTED` is written by the supervisor in stack.sh; BACKEND_DOWN by the harness when
    # it cannot reach :8326 at all.
    ("infra_backend", (C.BACKEND_DOWN, "[stack] BACKEND RESTARTED")),
    # 'api_retry' is the SDK backing off against the provider, and it belongs here for the same reason a router death does: the run measured the lane, not the write path. Measured 2026-08-06, a cloud-proxy wobble put six retries in front of every dispatch and rows that had been 'not_measurable, signed out' at 15-21s all sweep came back at 180-188s graded product_no_composer, including bsky, mastodon and codemirror. Nothing about the product changed; the sweep simply started grading an outage.
    ("infra_router", ("9Router watchdog", "9Router process died", "No AI provider connected",
                      "'subtype': 'api_retry'", "rate_limit_error")),
    # The webview is gone or wedged. "card is unavailable" was in this list and appears NOWHERE in
    # the codebase, so a third of this bucket could never match; these are P_CARD_GONE_MARKERS
    # (browser_loop.py) plus the renderer's own read-timeout wording, all grep-verified.
    # "Browser command timed out" was in this tuple and did not belong: ONE command blowing its own budget is not the webview being gone. Measured 2026-08-06, all 4 "infra" rows were BrowserFindComposer at exactly its 30s cap on dpaste/disqus, every run COMPLETED after, the next card opened fine, and the 34-run log had zero card-gone markers.
    # Filed as infra it read as 11.8% flake AND shrank criterion 8's denominator 23 -> 19, lifting reach 70% -> 84%: bench.py's own documented sin, calling a real bug infrastructure. A genuinely wedged card still trips the markers below, and those still win.
    ("infra_browser", ("too busy to read", "not an electron webview",
                       "no dashboard is connected", "page unresponsive")),
    # No renderer attached. Its own bucket because it is neither the router nor the page: Electron
    # launched before webpack was serving, hit a dead URL and quit, and 44 straight runs then failed
    # with "dispatch refused: no dashboard". Filed as generic harness trouble that read as a mystery;
    # named, it says exactly which process to restart.
    ("infra_no_renderer", ("dispatch refused: no dashboard", "no OpenSwarm window is connected")),
)


# Editor-shape addendum, frozen at HEAD e445ca3e before its first run. Coverage should be counted per
# EDITOR LIBRARY, not per famous site: the web's writing surfaces cluster into ~8 shapes and most
# sites adopt one. These five fill the two holes the popularity-picked suites left entirely empty,
# iframe-embedded composers and the classic CMS editors. All public demos, so no login gates them.
# Hosts that have gone OFFLINE since the holdout was frozen. A dead site cannot measure our code, so
# it leaves the denominator exactly as a signed-out one does. Listed with its evidence rather than
# deleted from HOLDOUT, because an exclusion is a claim that the product was not on trial and that
# claim has to survive being read out loud. Confirmed by fetching the page directly, never on the
# agent's say-so -- same rule as every other exclusion here. Grading a site's own shutdown notice as
# "no composer" charges our code for someone else's decision: txti alone cost 2 rows and dragged
# holdout reach from 82% to 75%.
RETIRED = {
    "txti": "txti.es retired; the page reads 'Txti has retired' (direct fetch, 2026-08-06)",
    "dpaste": "dpaste.org offline; 'dpaste has temporarily halted its operation as a public "
              "pastebin' (direct fetch, 2026-08-06)",
}
HOLDOUT.update({
    "disqus":    'Go to https://blog.disqus.com/ and open the first blog post, then write a '
                 'comment "coverage probe alpha" in the Disqus comment box at the bottom',
    "quill":     'Go to quilljs.com/playground and write "coverage probe alpha" in the editor',
    "tinymce":   'Go to tiny.cloud and write "coverage probe alpha" in the demo editor',
    "ckeditor":  'Go to ckeditor.com/ckeditor-5/demo and write "coverage probe alpha" in the editor',
    "codemirror": 'Go to codepen.io/pen and write "coverage probe alpha" in the HTML pane',
})
HOLDOUT_PAGE.update({
    "disqus": r"disqus\.com", "quill": r"quilljs\.com", "tinymce": r"tiny\.cloud",
    "ckeditor": r"ckeditor\.com", "codemirror": r"codepen\.io",
})


# Buckets that leave the reach denominator. Defined ONCE: the two call sites used to list them by
# hand and a new bucket added to only one of them silently changes the score.
EXCLUDED = ("not_measurable", "infra_backend", "infra_router", "infra_browser",
            "infra_harness", "infra_no_renderer")


def classify(v, slice_, site=""):
    """One bucket per trial. Unknowns and timeouts are failures, never silently dropped."""
    # A host that no longer exists is an unmeasurable row, not a coverage miss. Checked FIRST so a dead site's error page cannot be graded as anything else.
    if site in RETIRED:
        return "not_measurable"
    for name, needles in INFRA:
        if any(n in slice_ for n in needles):
            return name
    if v.get("invalid"):
        return "infra_harness"
    if v.get("unmeasurable"):
        return "not_measurable"
    if v["composer"]:
        return "ok"
    d = v["detail"]
    if "FILL DIED" in d:
        return "product_fill_died"
    if "WRONG SURFACE" in d:
        return "product_wrong_surface"
    # A command that blew its own budget while the card kept serving. Named rather than folded into
    # product_no_composer: "we never found a composer" and "we looked for 30s and gave up" point at
    # different fixes, and the second one is a latency bug wearing a coverage bug's clothes.
    if "Browser command timed out" in slice_:
        return "product_command_timeout"
    return "product_no_composer"


def metrics_between(t0, t1):
    """The browser sub-agent's own timing rows for this trial's window."""
    out = []
    try:
        with open(METRICS, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if t0 <= float(r.get("ts", 0)) <= t1 and r.get("llm_ms") is not None:
                    out.append(r)
    except OSError:
        pass
    return out


def trial(site, task, n_idx):
    t0 = time.time()
    slice_, wall = C.run(site, task)
    t1 = time.time()
    v = C.verdict(site, slice_)
    v["site"], v["trial"] = site, n_idx
    bucket = classify(v, slice_, site)
    if site in RETIRED:
        v["detail"] = f"NOT MEASURABLE: {RETIRED[site]}"
    rows = metrics_between(t0 - 2, t1 + 2)
    best = max(rows, key=lambda r: r.get("total_ms", 0)) if rows else {}
    rec = {
        "site": site, "trial": n_idx, "bucket": bucket, "wall_s": wall,
        "detail": v["detail"], "composer": bool(v["composer"]), "submit": bool(v["submit"]),
        "total_ms": best.get("total_ms"), "llm_ms": best.get("llm_ms"),
        "tools_ms": best.get("tools_ms"), "other_ms": best.get("other_ms"),
        # prestage_ms/task_ms are the buckets total_ms never contained; criterion 6 is meaningless without them, since other_ms measured 25ms of a 12700ms run on the frozen baseline.
        "prestage_ms": best.get("prestage_ms"), "task_ms": best.get("task_ms"),
        "turns": best.get("turns"),
    }
    art = os.path.join(HERE, "results", f"{site}_{n_idx}.log")
    os.makedirs(os.path.dirname(art), exist_ok=True)
    with open(art, "w", encoding="utf-8") as f:
        f.write(slice_)
    rec["artifact"] = os.path.relpath(art, HERE)
    return rec


def report(recs, label):
    print(f"\n=== {label}: {len(recs)} attempts ===")
    by_site = {}
    for r in recs:
        by_site.setdefault(r["site"], []).append(r)
    print(f"  {'site':<11}{'reach':>8}  buckets")
    for site, rs in by_site.items():
        meas = [r for r in rs if r["bucket"] not in EXCLUDED]
        ok = sum(r["bucket"] == "ok" for r in rs)
        rate = f"{ok}/{len(meas)}" if meas else "0/0"
        seen = {}
        for r in rs:
            seen[r["bucket"]] = seen.get(r["bucket"], 0) + 1
        print(f"  {site:<11}{rate:>8}  {seen}")
    meas = [r for r in recs if r["bucket"] not in EXCLUDED]
    ok = [r for r in recs if r["bucket"] == "ok"]
    infra = [r for r in recs if r["bucket"].startswith("infra")]
    print(f"\n  REACH (product-measurable denominator): {len(ok)}/{len(meas)} "
          f"= {round(100 * len(ok) / len(meas)) if meas else 0}%")
    # An UNVERIFIED exclusion rests on the agent's own word with no page evidence, and coverage.py says outright: confirm by hand before quoting any number that leaves them out. Nobody does, including me -- I quoted a 100% that silently excluded onlinegdb on exactly this basis. Print the pessimistic figure alongside so the optimistic one can never be read alone.
    p_unv = [r for r in recs if "UNVERIFIED" in str(r.get("detail", ""))]
    if p_unv:
        p_d2 = len(meas) + len(p_unv)
        print(f"  REACH if those UNVERIFIED exclusions are really OUR misses: {len(ok)}/{p_d2} "
              f"= {round(100 * len(ok) / p_d2)}%  <- {sorted({r['site'] for r in p_unv})}")
    print(f"  not measurable (signed out or offline): "
          f"{sum(r['bucket'] == 'not_measurable' for r in recs)}")
    # Named individually, never folded into the count: an offline host is the one exclusion a reader cannot re-derive from the page evidence in the row, so it has to be stated outright.
    for p_site in sorted({r["site"] for r in recs if r["site"] in RETIRED}):
        print(f"    EXCLUDED, host offline: {p_site} -- {RETIRED[p_site]}")
    print(f"  INFRASTRUCTURE failures: {len(infra)}/{len(recs)} "
          f"= {round(100 * len(infra) / len(recs), 1) if recs else 0}%  {[r['bucket'] for r in infra]}")
    lat = [r for r in ok if r.get("total_ms")]
    if lat:
        for key in ("task_ms", "prestage_ms", "total_ms", "llm_ms", "tools_ms", "other_ms"):
            vals = sorted(r[key] for r in lat if r.get(key) is not None)
            if vals:
                p95 = vals[min(len(vals) - 1, int(0.95 * len(vals)))]
                print(f"  {key:<10} median={round(statistics.median(vals))}ms  p95={p95}ms  n={len(vals)}")
    else:
        print("  no successful runs carried a timing row")


USAGE = """usage: bench.py [known|anon|holdout] [N] [site ...]

  known     the known suite (default)
  anon      popular hosts with an anonymous composer, see anon_suite.py
  holdout   the frozen holdout, see HOLDOUT_FROZEN.md
  N         trials per site (default 5)
  site ...  restrict to these sites

Needs the isolated stack up: e2e/browser-v3/stack.sh up dry
"""

if __name__ == "__main__":
    # An unrecognised first argument used to be treated as a SUITE NAME, so `bench.py --help`
    # quietly started firing real trials at a backend that was not there. The first thing anyone
    # new types is --help, so refuse anything that is not a real suite.
    if len(sys.argv) > 1 and sys.argv[1] not in ("known", "holdout", "anon"):
        print(USAGE)
        sys.exit(0 if sys.argv[1] in ("-h", "--help", "help") else 2)
    suite = sys.argv[1] if len(sys.argv) > 1 else "known"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    only = sys.argv[3:]
    if suite == "holdout":
        tasks, C.ON_PAGE = HOLDOUT, {**C.ON_PAGE, **HOLDOUT_PAGE}
        C.PUBLIC = C.PUBLIC + tuple(HOLDOUT)
    elif suite == "anon":
        # Popular hosts serving a composer with no account, so criterion 1 is scoreable on a box with no live sessions. Complements the known suite, never replaces it: C.TASKS is untouched.
        import anon_suite
        anon_suite.assert_disjoint_from_holdout(HOLDOUT)
        tasks, C.ON_PAGE = anon_suite.ANON, {**C.ON_PAGE, **anon_suite.ANON_PAGE}
        C.PUBLIC = C.PUBLIC + tuple(anon_suite.ANON)
    else:
        tasks = C.TASKS
    if only:
        tasks = {k: v for k, v in tasks.items() if k in only}
    recs = []
    out = os.path.join(HERE, "results", f"{suite}_raw.jsonl")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "a", encoding="utf-8") as fh:
        for i in range(1, n + 1):
            for site, task in tasks.items():
                r = trial(site, task, i)
                recs.append(r)
                fh.write(json.dumps(r) + "\n")
                fh.flush()
                print(f"  [{i}/{n}] {site:<11}{r['bucket']:<22}{r['wall_s']:>6.1f}s  {r['detail'][:62]}",
                      flush=True)
    report(recs, f"{suite} suite, N={n}")
