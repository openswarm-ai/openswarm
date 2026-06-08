"""
Smart wait: return as soon as the page's network has SETTLED, instead of the
blind fixed sleep BrowserWait used to do.

The audit found blind `BrowserWait(2500)` sleeps eat ~42% of all run time, the
page is usually ready long before the fixed duration elapses (navigate already
waits for the main load, so the agent's extra wait is just for SPA XHR content
to finish). So we poll the page's actual network activity (the Performance
Resource Timing API, which records every fetch/XHR with timestamps) and return
the instant it's been quiet for a short window.

Reliability-preserving by construction, the whole point is to be FASTER without
being flakier:
- We wait for REAL network quiet, not a guess, so we don't read a half-loaded page.
- We NEVER return before the floor (skips a momentary gap between two requests).
- We NEVER wait longer than the caller asked (the requested ms is a hard cap).
- A page that keeps fetching (live feed) simply rides to the cap, same as before.

Backend-side + provider-free: the probe runs through the existing BrowserEvaluate
path, so there's no Electron/IPC change to packaged-build-test, and the decision
logic is a pure function we can hammer with tests.
"""

import asyncio
import json
import logging
import time

logger = logging.getLogger(__name__)

# One probe, built per wait so it can also look for the agent's target. Returns:
#   ready  - document.readyState === 'complete'
#   quiet  - ms since the last network resource (the old network-idle signal)
#   elems  - element count; the loop watches it stop changing = DOM/visual settle
#   found  - the agent's `until` target is present + visible (visible text or selector)
# `until` is JSON-encoded into a string literal, so it's data, never executable.
def _probe_js(until: str) -> str:
    spec = json.dumps(until or "")
    return (
        "(()=>{const n=performance.now();"
        "const es=performance.getEntriesByType('resource');let last=0;"
        "for(const e of es){const t=Math.max(e.responseEnd||0,e.startTime||0);if(t>last)last=t;}"
        f"let found=false;const spec={spec};"
        "if(spec){try{const low=spec.toLowerCase();"
        "let el=[...document.querySelectorAll('button,a,[role],input,textarea,[contenteditable],[aria-label],h1,h2')]"
        ".find(e=>((e.innerText||e.value||e.getAttribute('aria-label')||'')+'').toLowerCase().includes(low));"
        "if(!el){try{el=document.querySelector(spec);}catch(_){}}"
        "if(el){const r=el.getBoundingClientRect();found=r.width>0&&r.height>0;}}catch(_){}}"
        "return JSON.stringify({ready:document.readyState==='complete',"
        "quiet:Math.round(n-last),elems:document.getElementsByTagName('*').length,found});})()"
    )

_QUIET_WINDOW_MS = 400   # network must be silent this long to count as settled
_FLOOR_MS = 250          # never return before this (a momentary gap isn't 'settled')
_POLL_MS = 150
# A healthy probe is tens of ms. A busy-but-fine SPA (heavy main-thread work mid-
# hydration) can occasionally block longer, so a slow probe is NOT proof of death,
# it's just a reason to stop THIS wait early instead of inheriting the 30s command
# timeout. We bound each probe at this, and after a few consecutive non-responses
# we surface hung=True as a SIGNAL (the loop folds it into a cross-command streak
# and only then acts), never as a unilateral abort from a single wait.
_PROBE_TIMEOUT_S = 2.5
_MAX_PROBE_TIMEOUTS = 3


def decide_stop(ready, quiet_ms, dom_stable_ms, found, elapsed_ms,
                floor_ms=_FLOOR_MS, settle_window_ms=_QUIET_WINDOW_MS) -> bool:
    """Pure decision. Stop the INSTANT the agent's target is present (no floor, it's
    exactly what we were waiting for). Otherwise, past the floor and once the document
    is complete, stop as soon as it has gone quiet by EITHER the network OR the DOM
    settling. Watching DOM-settle as well as network is what stops beacon-heavy SPAs
    (LinkedIn, Gmail) riding to the cap while visually done: their network never idles,
    but their DOM does."""
    if found:
        return True
    if elapsed_ms < floor_ms:
        return False
    if not ready:
        return False
    return (quiet_ms or 0) >= settle_window_ms or (dom_stable_ms or 0) >= settle_window_ms


async def smart_wait(execute_fn, browser_id, tab_id, max_ms, *, until="",
                     poll_ms=_POLL_MS, floor_ms=_FLOOR_MS,
                     quiet_window_ms=_QUIET_WINDOW_MS,
                     probe_timeout_s=_PROBE_TIMEOUT_S, target_only=False) -> dict:
    """Wait up to `max_ms`, returning early once the page is ready. `until` (optional)
    is a label / visible text / selector the agent expects to appear; the wait ends the
    INSTANT it's present, so the agent isn't waiting blind. `execute_fn` is an async
    (tool, params, browser_id, tab_id) -> result|None (None = cancelled). Never raises.
    If the page stops responding to probes (hung tab), returns fast with hung=True so the
    caller can bail instead of inheriting the long command timeout.

    target_only: when True (used for confirming an action), the page merely SETTLING
    is not enough, only the `until` target appearing ends the wait early. This catches
    a result that renders a beat AFTER settle (a sent message landing in a thread under
    load), which the settle-early path otherwise misses, reporting a false 'not confirmed'."""
    max_ms = max(100, min(int(max_ms or 1000), 10000))
    probe_js = _probe_js(until)
    start = time.monotonic()
    settled = False
    found = False
    hung = False
    last_url = ""
    probe_timeouts = 0
    last_elems = None
    elems_changed_at = start  # DOM-settle clock: when the element count last changed

    def _elapsed():
        return (time.monotonic() - start) * 1000

    while _elapsed() < max_ms:
        await asyncio.sleep(min(poll_ms, max(0, max_ms - _elapsed())) / 1000)
        if _elapsed() >= max_ms:
            break
        # Bound each probe so a wedged tab can't make us inherit the 30s command
        # timeout. A timeout is a not-responding signal (not a verdict): count
        # consecutive ones and surface hung only after the threshold; any non-
        # timeout error is a different problem, treated as 'keep waiting'.
        try:
            res = await asyncio.wait_for(
                execute_fn("BrowserEvaluate", {"expression": probe_js}, browser_id, tab_id),
                timeout=probe_timeout_s,
            )
        except asyncio.TimeoutError:
            probe_timeouts += 1
            if probe_timeouts >= _MAX_PROBE_TIMEOUTS:
                hung = True
                break
            continue
        except Exception as e:
            logger.debug(f"[smart-wait] probe error (not a timeout): {e}")
            continue
        probe_timeouts = 0     # a response resets the streak (busy != dead)
        if res is None:        # cancelled mid-wait
            break
        last_url = res.get("url") or last_url
        if "error" in res:     # page mid-navigation / not evaluable yet, keep waiting
            continue
        try:
            probe = json.loads(res.get("text") or "{}")
        except Exception:
            continue
        elems = probe.get("elems")
        if elems != last_elems:
            last_elems = elems
            elems_changed_at = time.monotonic()
        dom_stable_ms = (time.monotonic() - elems_changed_at) * 1000
        # Confirming an action (target_only): only the target appearing counts; a
        # bare settle without it keeps waiting, so a late-rendering result isn't a
        # false miss. Bounded by max_ms either way.
        if target_only and until:
            if probe.get("found"):
                settled = True
                found = True
                break
            continue
        if decide_stop(probe.get("ready"), probe.get("quiet", 0), dom_stable_ms,
                       probe.get("found"), _elapsed(),
                       floor_ms=floor_ms, settle_window_ms=quiet_window_ms):
            settled = True
            found = bool(probe.get("found"))
            break

    waited = round(_elapsed())
    if found:
        state = "found target"
    elif settled:
        state = "page settled"
    elif hung:
        state = "page not responding"
    else:
        state = "reached cap"
    text = f"Waited {waited}ms ({state})."
    if hung:
        text += " The page or tab appears unresponsive."
    if last_url:
        text += f" Current URL: {last_url}"
    return {"text": text, "url": last_url, "settled": settled, "found": found, "hung": hung,
            "waited_ms": waited, **({"error": "page unresponsive"} if hung else {})}
