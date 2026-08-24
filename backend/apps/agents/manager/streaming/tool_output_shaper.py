"""Bound what ONE tool result costs the model, without deleting the answer.

Why this exists: the shipped 50KB per-message cap (`truncate_large_tool_result`) shapes our own
transcript copy, NOT what the model carries, and on 6,389 real tool results the largest is 37,029
bytes, so it could never have fired anyway. Measured on that corpus: tool results are 45.9% of all
message tokens, and in the deepest sessions 70-91% of that mass sits in results over 4KB. Silent
quits scale with depth, so this is the lever that actually touches them.

The rule that keeps it honest: NOTHING IS EVER REMOVED WITHOUT A WAY TO GET IT BACK. Every shaped
body names the file holding the full output, so a shaper that guesses wrong costs a re-read, never
the answer. Measured on the same corpus, a plain head+tail shaper destroys ~100% of answer-shaped
lines (the RTK failure); carrying those lines drops it to 1-4%, and the recovery path covers the rest.
"""

import re
from typing import Optional, Tuple

from typeguard import typechecked

# The knee, measured, not guessed: 4,000 bytes fires on 5.9% of real results and reclaims 52.8% of
# tool tokens. Below it the curve flattens (2,000 buys 3 more points) while touching half again as
# many results, and above it the reclaim falls off a cliff (10,000 -> 22.6%).
SHAPE_OVER_BYTES = 4_000
HEAD_CHARS = 1_200
TAIL_CHARS = 800
# A cap on carried lines, so a 200K-line log of nothing but errors cannot re-inflate what we just cut.
MAX_CARRIED_LINES = 60
CARRIED_LINE_CHARS = 400

# Lines a user's question is usually ABOUT. Not a correctness boundary (the recovery path is), just
# the difference between the model answering now and the model running the command again.
P_NOTABLE = re.compile(
    r"\b(FATAL|CRITICAL|ERROR|Traceback|Exception|panic:|SIGSEGV"
    r"|\d+\s+(?:passed|failed|error)|FAILED|assert"
    r"|nothing to commit|Permission denied|No such file"
    r"|trace[_-]?id|request[_-]?id)\b",
    re.IGNORECASE,
)

# Where each known payload lives. A shape absent from here is NEVER guessed at: an unrecognised
# body is returned untouched and counted, because a replacement that does not match the tool's
# output schema is dropped by the CLI in silence (measured: a bare string for Bash vanished with
# no error), and a silent drop is indistinguishable from a shaper that never ran.
DICT_TEXT_FIELDS = ("stdout", "content", "text", "output")


@typechecked
def shape_text(body: str, recovery: str) -> str:
    """Head + the notable lines from the middle + tail, and always where to find the rest."""
    if len(body) <= HEAD_CHARS + TAIL_CHARS:
        return body
    head, tail = body[:HEAD_CHARS], body[-TAIL_CHARS:]
    middle = body[HEAD_CHARS:len(body) - TAIL_CHARS]
    carried = [ln.strip()[:CARRIED_LINE_CHARS]
               for ln in middle.splitlines() if P_NOTABLE.search(ln)][:MAX_CARRIED_LINES]
    note = f"[... {len(middle)} chars elided by OpenSwarm. Full output: {recovery} ...]"
    if carried:
        note += "\nNotable lines from the elided part:\n" + "\n".join(carried)
    return f"{head}\n{note}\n{tail}"


@typechecked
def shape_tool_response(response: object, recovery: str) -> Tuple[Optional[object], int, int]:
    """Return (replacement, before_bytes, after_bytes); replacement is None when nothing was done.

    The replacement keeps the ORIGINAL SHAPE, because the CLI validates it against the tool's own
    output schema and silently discards a mismatch."""
    if isinstance(response, str):
        if len(response.encode("utf-8", "ignore")) <= SHAPE_OVER_BYTES:
            return None, 0, 0
        out = shape_text(response, recovery)
        return out, len(response), len(out)

    if isinstance(response, dict):
        field = next((f for f in DICT_TEXT_FIELDS
                      if isinstance(response.get(f), str) and len(response[f]) > SHAPE_OVER_BYTES), None)
        if field is None:
            return None, 0, 0
        out = shape_text(response[field], recovery)
        return {**response, field: out}, len(response[field]), len(out)

    if isinstance(response, list):
        idx = None
        for i, block in enumerate(response):
            if (isinstance(block, dict) and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                    and len(block["text"].encode("utf-8", "ignore")) > SHAPE_OVER_BYTES):
                if idx is None or len(block["text"]) > len(response[idx]["text"]):
                    idx = i
        if idx is None:
            return None, 0, 0
        before = response[idx]["text"]
        out = shape_text(before, recovery)
        replaced = list(response)
        replaced[idx] = {**response[idx], "text": out}
        return replaced, len(before), len(out)

    return None, 0, 0


@typechecked
def shape_for_model(session: object, session_id: str, response: object, msg_id: str,
                    tool_name: str) -> Optional[object]:
    """Park the full body, hand the model a bounded version, and keep the session's running tally.

    Returns None when nothing was shaped, which is the common case by design: on real traffic this
    fires on ~6% of results. The tally is what makes a dead shaper visible (see `shaping_report`)."""
    import logging
    import os
    from backend.apps.agents.manager.session.history_compaction import write_blob

    logger = logging.getLogger(__name__)
    # A DECLARED off switch, so the A/B control arm is the same binary with one seam flipped, and so
    # a user who hits a bad shape has a lever that is not "downgrade". It announces itself: a guard
    # that stops guarding in silence is the bug class this module was written under.
    if os.environ.get("OSW_TOOL_SHAPING") == "off":
        p_bump(session, "disabled", 1)
        if getattr(session, "_shaping_off_said", False) is False:
            logger.warning("tool-output shaping is OFF (OSW_TOOL_SHAPING=off); every tool result "
                           "will be sent to the model in full")
            try:
                session._shaping_off_said = True  # type: ignore[attr-defined]
            except Exception:
                pass
        return None
    probe, _, _ = shape_tool_response(response, "")
    if probe is None:
        p_bump(session, "seen", 1)
        return None

    p_body = _payload_text(response)
    blob = write_blob(p_body, session_id, msg_id, suffix="-model") if p_body else None
    if blob is None:
        # No recovery path means the cut would be unrecoverable, which is the one thing this must
        # never do. Spend the tokens instead.
        logger.warning(f"tool-output shaping skipped for {session_id}: full body could not be parked")
        p_bump(session, "skipped_no_recovery", 1)
        return None

    shaped, before, after = shape_tool_response(response, blob)
    if shaped is None:
        return None
    p_bump(session, "seen", 1)
    p_bump(session, "shaped", 1)
    p_bump(session, "bytes_before", before)
    p_bump(session, "bytes_after", after)
    logger.info(f"shaped {tool_name} result for the model: {before} -> {after} bytes (full copy at {blob})")
    return shaped


def _payload_text(response: object) -> str:
    """The field shape_tool_response would rewrite, so the parked copy is the thing being cut."""
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        for f in DICT_TEXT_FIELDS:
            if isinstance(response.get(f), str) and len(response[f]) > SHAPE_OVER_BYTES:
                return response[f]
    if isinstance(response, list):
        best = ""
        for block in response:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                if len(block["text"]) > len(best):
                    best = block["text"]
        return best
    return ""


def p_bump(session: object, key: str, n: int) -> None:
    stats = getattr(session, "tool_shaping", None)
    if not isinstance(stats, dict):
        stats = {}
        try:
            session.tool_shaping = stats  # type: ignore[attr-defined]
        except Exception:
            return
    stats[key] = stats.get(key, 0) + n


@typechecked
def shaping_report(session: object) -> Optional[str]:
    """One line when a session has gone deep and this has cut NOTHING, because a guard that never
    fires is indistinguishable from one that was never needed (the 50KB cap lived there for months)."""
    stats = getattr(session, "tool_shaping", None)
    if not isinstance(stats, dict) or stats.get("seen", 0) < 40:
        return None
    if stats.get("shaped", 0) > 0:
        cut = stats.get("bytes_before", 0) - stats.get("bytes_after", 0)
        return (f"tool-output shaping: {stats['shaped']} of {stats['seen']} results shaped, "
                f"{cut:,} bytes kept out of the model's context")
    return (f"tool-output shaping fired on 0 of {stats['seen']} results; this session is paying "
            f"full freight for every tool result")
