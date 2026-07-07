"""Cap the cumulative text of a FastMCP call_tool return so one Gmail/Drive dump can't
blow the model's context. Pure + stdlib-only (no upstream imports) so it's importable
and unit-testable outside the shim's ephemeral uv env.

The bundled Claude CLI hard-rejects any MCP result over ~25K tokens and spills it to a
file, which the model then re-reads back in, refilling the context and tripping the CLI's
autocompact-thrash. Capping under that spill threshold keeps the result inline and the
model out of the re-read loop. Lossless: the full text is saved to a report file the
model can Read selectively, and the truncation note points at it."""

import os
import time
from typing import Any

MAX_RESULT_CHARS = 48_000
REPORT_DIR = os.environ.get(
    "OPENSWARM_TOOL_REPORT_DIR",
    os.path.join(os.path.expanduser("~"), ".openswarm", "tool-reports"),
)
P_TRUNCATION_NOTE = (
    "\n\n[Truncated: this tool returned more than {cap} characters, too much to fit "
    "in context at once.{saved} Narrow the request (add a search filter, a date range, "
    "or a smaller max_results / page size) or fetch the next page.]"
)


def p_spill(text: str) -> str:
    """Write the full result to disk so the cap is lossless; empty string on failure."""
    try:
        os.makedirs(REPORT_DIR, exist_ok=True)
        # Reports are point-in-time working files, not archives; prune week-old ones so the folder can't grow forever.
        cutoff = time.time() - 7 * 86400
        for old in os.listdir(REPORT_DIR):
            p = os.path.join(REPORT_DIR, old)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
        path = os.path.join(REPORT_DIR, f"gws-result-{os.getpid()}-{int(time.time()*1000)}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path
    except Exception:
        return ""


def cap_tool_result(result: Any, max_chars: int = MAX_RESULT_CHARS) -> Any:
    """Cap the text content blocks of a call_tool return in place. Duck-typed and
    fail-open: any shape we don't recognize passes through unchanged, so an upstream
    contract change degrades to no-cap, never a crash."""
    try:
        blocks = result[0] if isinstance(result, tuple) else result
        if not isinstance(blocks, list):
            return result
        texts = [
            b.text for b in blocks
            if getattr(b, "type", None) == "text" and getattr(b, "text", None) is not None
        ]
        if sum(len(t) for t in texts) <= max_chars:
            return result
        full_path = p_spill("\n".join(texts))
        saved = f" The complete result was saved to {full_path}; Read it with offset/limit if you truly need the rest." if full_path else ""
        used = 0
        truncated = False
        for b in blocks:
            if getattr(b, "type", None) != "text" or getattr(b, "text", None) is None:
                continue
            if truncated:
                b.text = ""
                continue
            text = b.text
            if used + len(text) <= max_chars:
                used += len(text)
                continue
            b.text = text[: max(0, max_chars - used)] + P_TRUNCATION_NOTE.format(cap=max_chars, saved=saved)
            truncated = True
        return result
    except Exception:
        return result
