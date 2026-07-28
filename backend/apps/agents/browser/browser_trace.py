"""One auditable record of what the browser actually did, whatever tier did it.

The user-facing promise is that a browser task is never "just trust me": the chat shows a Browser
Agent bubble you can expand to see the pages visited, what was clicked and typed, and the receipt
that proves a write landed. That promise held only on the sub-agent path, because the panel that
renders it reads from CHILD SESSIONS. The fast path creates no child session and closed its bubble
with a tool_result of literally "done", so on the tier that now handles most tasks the bubble
expanded to nothing at all.

So the trace stops being a side effect of how the work was routed. Whichever tier ran builds the
same record here, and the bubble shows the same thing every time.

Pure formatting: no I/O, no side effects, nothing that can fail a run.
"""

import json
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

# Enough to see what happened without turning the panel into a log file. A run that exceeds this
# says so rather than silently showing a prefix, because a trace you cannot trust to be complete is
# worse than no trace.
MAX_STEPS = 40
MAX_ARG_CHARS = 90

# Tools whose arguments are the interesting part (where it went, what it typed) versus ones whose
# name already says everything (a screenshot is a screenshot).
P_ARG_KEYS = ("url", "text", "expression", "instruction", "target_text", "index", "name", "key")


class BrowserTrace(BaseModel):
    """What to show under the bubble. Shaped so the renderer never parses prose."""

    model_config = ConfigDict(validate_assignment=True)

    tier: str = ""                       # which path did the work, in plain words
    pages: List[str] = []                # URLs actually visited, in order, deduped
    steps: List[str] = []                # one line per action, already human-readable
    steps_omitted: int = 0
    receipt: str = ""                    # the proof a write landed, when there was one
    note: str = ""                       # anything the user should know about coverage


@typechecked
def p_arg_summary(inp: Any) -> str:
    """The part of a tool's input worth showing, short enough to scan."""
    if not isinstance(inp, dict) or not inp:
        return ""
    for k in P_ARG_KEYS:
        v = inp.get(k)
        if v not in (None, "", []):
            s = str(v).replace("\n", " ").strip()
            return s[:MAX_ARG_CHARS] + ("..." if len(s) > MAX_ARG_CHARS else "")
    s = json.dumps(inp)[:MAX_ARG_CHARS]
    return s


@typechecked
def p_step_line(entry: Dict[str, Any]) -> str:
    tool = str(entry.get("tool") or "?")
    arg = p_arg_summary(entry.get("input"))
    ms = entry.get("elapsed_ms")
    ok = entry.get("ok")
    tail = f" [{int(ms)}ms]" if isinstance(ms, (int, float)) and ms else ""
    mark = "" if ok in (None, True) else " (failed)"
    return f"{tool}({arg}){tail}{mark}" if arg else f"{tool}{tail}{mark}"


@typechecked
def p_pages_from(action_log: List[Dict[str, Any]]) -> List[str]:
    """Every URL the run actually landed on, in order, without repeats. This is the spine of the
    trace: it answers "where did it go" before "what did it do there"."""
    out: List[str] = []
    for e in action_log:
        inp = e.get("input")
        url = str(inp.get("url") or "") if isinstance(inp, dict) else ""
        if url.startswith(("http://", "https://")) and (not out or out[-1] != url):
            out.append(url)
    return out


@typechecked
def build_trace(tier: str, action_logs: List[List[Dict[str, Any]]],
                receipt: str = "", note: str = "", entry_url: str = "") -> BrowserTrace:
    """Fold every dispatch a run made into one record. Takes a LIST of logs because a fast-path run
    can dispatch more than once (a recovery, a send probe) and the user should see all of it, not
    just whichever attempt happened to be last.

    `entry_url` matters more than it looks: a cold run creates the card ALREADY pointed at its
    target, so no BrowserNavigate is ever issued and harvesting URLs from the log alone leaves the
    trace unable to answer "where did it go" at all."""
    merged: List[Dict[str, Any]] = []
    for log in action_logs:
        merged.extend(e for e in (log or []) if isinstance(e, dict))
    pages = p_pages_from(merged)
    if entry_url.startswith(("http://", "https://")) and entry_url not in pages[:1]:
        pages = [entry_url] + pages
    shown = merged[-MAX_STEPS:]
    return BrowserTrace(
        tier=tier,
        pages=pages,
        steps=[p_step_line(e) for e in shown],
        steps_omitted=max(0, len(merged) - len(shown)),
        receipt=receipt,
        note=note,
    )


@typechecked
def trace_payload(trace: BrowserTrace) -> Dict[str, object]:
    """The tool_result content the bubble renders. Kept as data rather than a rendered string so the
    panel can lay it out, and so a future surface (an export, a report) does not have to re-parse
    English."""
    return {"browser_trace": trace.model_dump(mode="json")}


@typechecked
def trace_text(trace: BrowserTrace) -> str:
    """A plain-text fallback for anywhere that can only show a string."""
    lines: List[str] = []
    if trace.tier:
        lines.append(f"Handled by: {trace.tier}")
    if trace.pages:
        lines.append("Pages: " + " -> ".join(trace.pages[:6]))
    if trace.steps_omitted:
        lines.append(f"... {trace.steps_omitted} earlier steps omitted ...")
    lines.extend(f"{i}. {s}" for i, s in enumerate(trace.steps, trace.steps_omitted + 1))
    if trace.receipt:
        lines.append(f"Verified: {trace.receipt}")
    if trace.note:
        lines.append(trace.note)
    return "\n".join(lines) or "No browser actions were recorded."


@typechecked
def tier_label(fp_path: str, used_browser: bool) -> str:
    """Plain words for the routing string the logs use, because 'read->browser' means nothing to
    the person reading their own chat."""
    if not used_browser:
        return "read the page directly, no browser needed"
    if fp_path.startswith("read"):
        return "opened the page in a browser and read it"
    return "drove the browser"


@typechecked
def receipt_from(result: Optional[Dict[str, Any]]) -> str:
    """The two-sided receipt, when the run produced one. This is the line that separates 'it says it
    posted' from 'it posted', so it gets its own field rather than being buried in the steps."""
    if not isinstance(result, dict):
        return ""
    for key in ("receipt", "sent_receipt", "delivery"):
        v = result.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()[:300]
        if v is True:
            return "delivery confirmed on the page"
    return ""
