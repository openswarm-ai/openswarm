"""Hermes-style graded aging for the session recap (ENG-354 endgame; lifted from
NousResearch/hermes-agent agent/context_compressor.py::_prune_old_tool_results, MIT).

The old recap blind-head-truncated EVERY tool result at 500 chars (deleting exactly the
answers a long run needs back after a context break) and hard-dropped everything before the
compaction cutoff. Aging is recoverable instead of destructive: the newest results within a
token budget survive verbatim, small results survive whole, exact duplicates collapse to a
back-reference, and everything older becomes a one-line stub that KEEPS the tool name and
arguments, so the agent can re-run any call whose detail it still needs."""

import hashlib
import json
from typing import List, Tuple

from typeguard import typechecked

# Hermes floors: below this a result costs less than a summary of it would.
PRUNE_MIN_CHARS = 200
# Verbatim tail budget in chars (~3K tokens) plus a hard count floor, hermes-shaped.
TAIL_BUDGET_CHARS = 12_000
TAIL_COUNT_FLOOR = 7
# One verbatim survivor never eats the whole tail budget: middle-elide past this.
TAIL_ITEM_CAP = 6_000
STUB_ARGS_CAP = 160
DUPLICATE_LINE = "[Duplicate tool output — same content as a more recent call]"


@typechecked
def p_pair_calls(messages: List) -> dict:
    """index of each tool_result -> (tool_name, compact_args) from its nearest preceding call."""
    pairs = {}
    last_call: Tuple[str, str] = ("tool", "")
    for i, m in enumerate(messages):
        role = getattr(m, "role", "")
        c = getattr(m, "content", None)
        if role == "tool_call" and isinstance(c, dict):
            tool = str(c.get("tool") or c.get("name") or "tool")
            try:
                args = json.dumps(c.get("input"), ensure_ascii=False, default=str)
            except Exception:
                args = str(c.get("input"))
            last_call = (tool, args)
        elif role == "tool_result":
            name = c.get("tool_name") if isinstance(c, dict) else None
            pairs[i] = (str(name) if name else last_call[0], last_call[1])
    return pairs


@typechecked
def p_result_text(content: object) -> str:
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str):
            return text
        try:
            return json.dumps(content, ensure_ascii=False, default=str)
        except Exception:
            return str(content)
    return str(content)


@typechecked
def stub_line(tool: str, args: str, size: int) -> str:
    """The aged one-liner; the args survive so the call is re-runnable (the hermes property)."""
    compact = args.strip()
    if len(compact) > STUB_ARGS_CAP:
        compact = compact[:STUB_ARGS_CAP] + "..."
    return f"[{tool}] {compact} ({size:,} chars result)"


@typechecked
def elide_middle(text: str, cap: int) -> str:
    if len(text) <= cap:
        return text
    head = int(cap * 0.6)
    tail = cap - head
    return f"{text[:head]}\n[... {len(text) - cap:,} chars elided ...]\n{text[-tail:]}"


@typechecked
def age_tool_results(messages: List, cutoff_idx: int = -1) -> dict:
    """Decide each tool_result's recap fate. Returns index -> recap body string.

    Walking newest-first (hermes pass order): duplicates collapse to a back-reference,
    the newest results within TAIL_BUDGET_CHARS (or the TAIL_COUNT_FLOOR, whichever
    protects more) stay verbatim, small results always stay whole, and everything else,
    plus everything at or before ``cutoff_idx``, ages into a stub."""
    pairs = p_pair_calls(messages)
    fates: dict = {}
    seen_hashes: set = set()
    tail_spent = 0
    tail_kept = 0
    for i in range(len(messages) - 1, -1, -1):
        if i not in pairs:
            continue
        text = p_result_text(getattr(messages[i], "content", None))
        tool, args = pairs[i]
        if len(text) >= PRUNE_MIN_CHARS:
            h = hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()[:12]
            if h in seen_hashes:
                fates[i] = DUPLICATE_LINE
                continue
            seen_hashes.add(h)
        if len(text) < PRUNE_MIN_CHARS:
            fates[i] = text
            continue
        in_tail = i > cutoff_idx and (tail_kept < TAIL_COUNT_FLOOR or tail_spent < TAIL_BUDGET_CHARS)
        if in_tail:
            kept = elide_middle(text, TAIL_ITEM_CAP)
            fates[i] = kept
            tail_spent += len(kept)
            tail_kept += 1
        else:
            fates[i] = stub_line(tool, args, len(text))
    return fates
