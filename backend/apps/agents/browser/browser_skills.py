"""
Browser action-sequence skill cache (the "learn once, replay fast" layer).

The first time the full LLM agent completes a task, we distill the productive
action sequence and store it keyed by (host, normalized-task). A later identical
task on the same host can then REPLAY that sequence with zero LLM round-trips,
which is what gets a repeat task from ~50s down to ~1s (well under human time).

Robustness is the whole game here (a stale replay that "succeeds" wrongly is the
ghost-failure we must avoid), so:
  - clicks are recorded by (role, name), NOT by ephemeral index, and re-resolved
    fresh at replay time (handled by the click_by_name tool);
  - a skill is only recorded if EVERY productive step is robustly replayable and
    there is at least one real action (not just a navigate);
  - the replay executor (in browser_agent) verifies each step and falls back to
    the full LLM agent on any miss.

IN-MEMORY ONLY by design: a `type` step carries the typed text, which can be
sensitive, so we never write skills to disk. Cross-session persistence with
text redaction is future work. Process-lifetime, capped.
"""

import logging
import re
import time
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# key "host::task_sig" -> skill dict
_skills: dict[str, dict] = {}
_MAX_SKILLS = 200

# Tools that change page state (worth replaying). Reads/meta are never recorded.
_PRODUCTIVE = {"BrowserType", "BrowserClickIndex", "BrowserClick", "BrowserPressKey", "BrowserScroll"}

_URL_RE = re.compile(r"https?://\S+")
_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
# Filler words that don't change task identity; dropping them makes the
# signature robust to trivial rewordings of the same request.
_STOP = {
    "the", "a", "an", "to", "into", "on", "this", "that", "page", "please",
    "then", "and", "go", "open", "browser", "tell", "me", "whether", "it",
    "of", "in", "for", "with", "your", "after", "if", "you", "can",
}


def normalize_task(task: str) -> str:
    """Stable task signature: lowercase, drop urls/punct/filler, collapse ws.
    Two phrasings of the same trivial task should map to the same signature."""
    t = (task or "").lower()
    t = _URL_RE.sub(" ", t)
    t = _PUNCT_RE.sub(" ", t)
    toks = [w for w in _WS_RE.sub(" ", t).strip().split(" ") if w and w not in _STOP]
    return " ".join(toks)


def host_of(url: str) -> str:
    """host:port of a url (so different sites/ports never share a skill)."""
    try:
        p = urlparse(url)
        return (p.netloc or "").lower()
    except Exception:
        return ""


def distill_steps(action_log: list[dict]) -> list[dict]:
    """Turn a successful task's action_log into a robust replayable step list,
    or [] if it can't be made safely replayable.

    Each action_log entry is expected to carry: tool, input, ok, and for clicks
    the resolved clicked_role / clicked_name. Returns steps as
    {tool, params} pairs that execute_browser_tool understands.
    """
    steps: list[dict] = []
    productive_count = 0

    def _emit_simple(tool, inp):
        """Append a robust step for a simple action, or return False if this
        action can't be made robustly replayable (caller then bails)."""
        nonlocal productive_count
        if tool in ("BrowserType", "type") and inp.get("selector") is not None:
            steps.append({"tool": "BrowserType", "params": {"selector": inp.get("selector"), "text": inp.get("text", "")}})
            productive_count += 1; return True
        if tool in ("BrowserClick", "click") and inp.get("selector"):
            steps.append({"tool": "BrowserClick", "params": {"selector": inp["selector"]}})
            productive_count += 1; return True
        if tool in ("BrowserPressKey", "press_key") and inp.get("key"):
            steps.append({"tool": "BrowserPressKey", "params": {"key": inp["key"]}})
            productive_count += 1; return True
        if tool in ("BrowserScroll", "scroll"):
            steps.append({"tool": "BrowserScroll", "params": {k: inp[k] for k in ("direction", "amount") if k in inp}})
            productive_count += 1; return True
        if tool in ("BrowserNavigate", "navigate") and inp.get("url"):
            steps.append({"tool": "BrowserNavigate", "params": {"url": inp["url"]}})
            return True
        if tool in ("wait", "BrowserWait"):
            return True  # waits are skipped, not fatal
        return False  # unknown/unrobust -> signal bail

    for a in action_log:
        if not a.get("ok", True):
            continue  # never replay a step that failed when recorded
        tool = a.get("tool")
        inp = a.get("input") or {}
        if tool == "BrowserBatch":
            # The agent's efficient path bundles sub-actions. Flatten them so the
            # skill captures the real work. A batched click_index can't be made
            # robust (its resolved name isn't recoverable here), so bail rather
            # than record a flaky index-based step.
            subs = inp.get("actions") or []
            for sub in subs:
                st = sub.get("type")
                sp = sub.get("params") or {}
                if st == "click_index":
                    return []  # un-robustifiable batched click -> no skill
                if not _emit_simple(st, sp):
                    return []
            continue
        if tool == "BrowserNavigate" and inp.get("url"):
            steps.append({"tool": "BrowserNavigate", "params": {"url": inp["url"]}})
        elif tool == "BrowserType" and inp.get("selector") is not None:
            steps.append({"tool": "BrowserType", "params": {"selector": inp.get("selector"), "text": inp.get("text", "")}})
            productive_count += 1
        elif tool == "BrowserClickIndex":
            name = a.get("clicked_name")
            if not name:
                return []  # can't make this click robust -> don't record a flaky skill
            steps.append({"tool": "BrowserClickByName", "params": {"role": a.get("clicked_role", ""), "name": name}})
            productive_count += 1
        elif tool == "BrowserClick" and inp.get("selector"):
            steps.append({"tool": "BrowserClick", "params": {"selector": inp["selector"]}})
            productive_count += 1
        elif tool == "BrowserPressKey" and inp.get("key"):
            steps.append({"tool": "BrowserPressKey", "params": {"key": inp["key"]}})
            productive_count += 1
        elif tool == "BrowserScroll":
            steps.append({"tool": "BrowserScroll", "params": {k: inp[k] for k in ("direction", "amount") if k in inp}})
            productive_count += 1
        # everything else (reads, screenshots, waits, batch, evaluate) is dropped
    # A skill is only worth replaying if it has a real action, not navigate-only.
    if productive_count == 0:
        return []
    return steps


def record_skill(host: str, task: str, action_log: list[dict]) -> bool:
    """Record a replayable skill if the run distills to a safe sequence.
    Returns True if stored. Best-effort; never raises into the caller."""
    try:
        if not host:
            return False
        steps = distill_steps(action_log)
        if not steps:
            return False
        sig = normalize_task(task)
        if not sig:
            return False
        key = f"{host}::{sig}"
        _skills[key] = {
            "host": host, "task_sig": sig, "steps": steps,
            "recorded_at": time.time(), "replays": 0,
        }
        if len(_skills) > _MAX_SKILLS:  # evict oldest
            oldest = min(_skills, key=lambda k: _skills[k]["recorded_at"])
            _skills.pop(oldest, None)
        logger.info(f"[browser-skills] recorded {len(steps)}-step skill for {key}")
        return True
    except Exception as e:
        logger.debug(f"[browser-skills] record failed: {e}")
        return False


def find_skill(host: str, task: str) -> dict | None:
    """Return a matching skill for (host, task), or None."""
    if not host:
        return None
    sig = normalize_task(task)
    if not sig:
        return None
    return _skills.get(f"{host}::{sig}")


def mark_replayed(host: str, task: str) -> None:
    s = find_skill(host, task)
    if s:
        s["replays"] = s.get("replays", 0) + 1


def clear() -> None:
    _skills.clear()
