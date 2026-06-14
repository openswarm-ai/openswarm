"""
Granular, persisted metrics for the browser sub-agent.

Records one JSONL line per tool call and one summary line per task so we can
answer, after the fact: did the task complete, how long did each tool take,
how many tokens (cost) it burned, which tier did the work, and what errors
recurred. Pure best-effort: every call is wrapped so a metrics failure can
never break the agent loop.

Files (under DATA_ROOT/browser_metrics/, env-overridable):
  events.jsonl        one line per tool call
  tasks.jsonl         one line per finished task (with a recurring-error rollup)
  skill_events.jsonl  one line per skill-lifecycle transition (learn / promote /
                      edit / quarantine / demote / compose / invalidate), so we
                      can tell whether the skill layer ACTUALLY speeds repeats up
                      or is silently thrashing (re-learning every run, never
                      promoting), which is the ghost that "completes" but never
                      delivers the win.
"""

import json
import logging
import os
import re
import threading
import time
from collections import Counter

logger = logging.getLogger(__name__)

# Map each tool to the waterfall tier it represents, so per-tier speed/cost
# rolls up cleanly. Control/meta tools are their own bucket.
P_TIER = {
    "BrowserDetectWebMCP": "t1_webmcp",
    "BrowserListRoutes": "t2_route_list",
    "BrowserReplayRoute": "t2_route_replay",
    "BrowserListInteractives": "t3_action_surface",
    "BrowserClickIndex": "t3_action_surface",
    "BrowserGetText": "t4_content",
    "BrowserGetConsole": "t4_content",
    "BrowserGetElements": "t4_content",
    "BrowserScreenshot": "t5_vision",
    "BrowserNavigate": "nav",
    "BrowserClick": "ui_click",
    "BrowserType": "ui_type",
    "BrowserPressKey": "ui_key",
    "BrowserScroll": "ui_scroll",
    "BrowserBatch": "ui_batch",
    "BrowserEvaluate": "ui_eval",
    "BrowserWait": "wait",
    "ReportProgress": "meta",
    "RequestHumanIntervention": "meta_hitl",
}


def p_tier_for(tool_name: str) -> str:
    return P_TIER.get(tool_name, "other")


P_METRICS_DIR_CACHE: str | None = None


def metrics_dir() -> str:
    # Resolved + mkdir'd once, not on every tool call (this runs in the hot path).
    global P_METRICS_DIR_CACHE
    if P_METRICS_DIR_CACHE is not None:
        return P_METRICS_DIR_CACHE
    override = os.environ.get("OPENSWARM_BROWSER_METRICS_DIR")
    if override:
        base = override
    else:
        try:
            from backend.config.paths import DATA_ROOT
            base = os.path.join(DATA_ROOT, "browser_metrics")
        except Exception:
            import tempfile
            base = os.path.join(tempfile.gettempdir(), "openswarm_browser_metrics")
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
    except Exception:
        pass
    P_METRICS_DIR_CACHE = base
    return base


def p_append(filename: str, obj: dict) -> None:
    try:
        path = os.path.join(metrics_dir(), filename)
        # owner-only: these lines can carry task text and error snippets
        fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, default=str) + "\n")
    except Exception as e:
        logger.debug(f"[browser-metrics] write failed: {e}")


# A task prompt can carry a literal secret ("log in with password hunter2");
# scrub the value before it lands in tasks.jsonl. Keyword+value and known
# token prefixes only; the task's normal words stay greppable.
P_TASK_SECRET_RE = re.compile(
    r"\b(password|passcode|passphrase|pin|otp|token|secret|api[_-]?key)\b\s*(?:is|[:=])?\s*\S+",
    re.I,
)
P_TASK_TOKEN_RE = re.compile(r"\b(sk-|ghp_|gho_|pk_|xox[bap]-|AIza|eyJ)[A-Za-z0-9_\-.]{8,}")


def p_scrub_task(task: str) -> str:
    t = P_TASK_SECRET_RE.sub(lambda m: f"{m.group(1)} [redacted]", task or "")
    return P_TASK_TOKEN_RE.sub("[redacted]", t)


def record_tool(session_id, browser_id, turn, tool, elapsed_ms, ok, error,
                is_loop, stagnation_streak, result_len) -> None:
    """One line per executed tool call. Best-effort."""
    p_append("events.jsonl", {
        "ts": time.time(),
        "session_id": session_id,
        "browser_id": browser_id,
        "turn": turn,
        "tool": tool,
        "tier": p_tier_for(tool),
        "elapsed_ms": elapsed_ms,
        "ok": bool(ok),
        "error": (error or "")[:160] if not ok else "",
        "is_loop": bool(is_loop),
        "stagnation_streak": stagnation_streak,
        "result_len": result_len,
    })
    # Human-greppable one-liner too, so it shows in the [backend] terminal pane.
    status = "OK" if ok else "ERR"
    logger.info(
        f"[browser-metrics] {tool} tier={p_tier_for(tool)} {elapsed_ms}ms {status} "
        f"turn={turn}{' LOOP' if is_loop else ''}"
        f"{f' STAGN={stagnation_streak}' if stagnation_streak else ''}"
    )


def record_skill_event(kind, host, task_sig, rev=0, state="", extra=None) -> None:
    """One line per skill-lifecycle transition. Best-effort. `kind` is one of
    learn / edit / promote / quarantine / demote / compose / invalidate. This is
    what lets the analyzer prove the skill layer is helping (promotes accumulate,
    repeats replay) vs. silently thrashing (re-learn loops, never promotes)."""
    p_append("skill_events.jsonl", {
        "ts": time.time(), "kind": kind, "host": host, "task_sig": task_sig,
        "rev": rev, "state": state, "extra": extra or {},
    })


def record_task(session_id, browser_id, task, status, started_at, turns,
                action_log, tokens, path="llm", task_sig="", playbook_seeded=False) -> dict:
    """One summary line per finished task: completion, total time, per-tier
    latency, token cost, and the recurring-error rollup. `path` records HOW the
    task finished (replay = no-LLM fast path, llm = full agent, llm_fallback =
    full agent after a replay miss) so we can measure the replay speedup and spot
    repeats that never reach the fast path. Returns the summary."""
    total_ms = int((time.time() - started_at) * 1000)
    by_tier = {}
    err_counter = Counter()
    for a in action_log:
        tool = a.get("tool", "?")
        tier = p_tier_for(tool)
        slot = by_tier.setdefault(tier, {"calls": 0, "total_ms": 0, "errors": 0})
        slot["calls"] += 1
        slot["total_ms"] += int(a.get("elapsed_ms", 0) or 0)
        rs = str(a.get("result_summary", ""))
        if rs.lower().startswith("error") or "not found" in rs.lower() or "no longer valid" in rs.lower():
            slot["errors"] += 1
            err_counter[rs[:80]] += 1
    for slot in by_tier.values():
        slot["avg_ms"] = round(slot["total_ms"] / slot["calls"], 1) if slot["calls"] else 0
    summary = {
        "ts": time.time(),
        "session_id": session_id,
        "browser_id": browser_id,
        "task": p_scrub_task(task)[:200],
        "task_sig": task_sig,
        "path": path,
        "playbook_seeded": bool(playbook_seeded),
        "status": status,
        "completed": status == "completed",
        "total_ms": total_ms,
        "turns": turns,
        "tool_calls": len(action_log),
        "tokens_in": (tokens or {}).get("input", 0),
        "tokens_out": (tokens or {}).get("output", 0),
        "by_tier": by_tier,
        "recurring_errors": err_counter.most_common(5),
    }
    p_append("tasks.jsonl", summary)
    logger.info(
        f"[browser-metrics] TASK {status} path={path} total={total_ms}ms turns={turns} "
        f"tools={len(action_log)} tok_in={summary['tokens_in']} tok_out={summary['tokens_out']} "
        f"recurring_errs={summary['recurring_errors'][:2]}"
    )
    p_maybe_self_audit()
    return summary


P_AUDIT_EVERY_N = 25   # refresh the learning self-audit roughly this often
P_TASK_COUNT = 0


def p_maybe_self_audit() -> None:
    """Every N finished tasks, refresh the self-audit report in a daemon thread so
    it never adds latency to a run (the audit is ~3ms but stays off the hot path).
    Proposal-only: it writes a report a human reads, it changes nothing."""
    global P_TASK_COUNT
    P_TASK_COUNT += 1
    if P_TASK_COUNT % P_AUDIT_EVERY_N != 0:
        return

    def p_run():
        try:
            from backend.apps.agents.browser import browser_self_audit
            browser_self_audit.run_and_write()
        except Exception:
            pass
    try:
        threading.Thread(target=p_run, name="browser-self-audit", daemon=True).start()
    except Exception:
        pass
