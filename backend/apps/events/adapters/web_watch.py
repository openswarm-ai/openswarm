"""Web-page poll adapter: the universal fallback for anything with no API (a
reservation page, a storefront, a status board). One SSRF-guarded fetch per
poll, diffed against the last extracted text; the emitted event carries the
newly-added text so the trigger's predicate can judge whether the change is
the one the user cares about. Fetch trouble raises (logged as a poll error)
instead of ever looking like a page change."""

import asyncio
import difflib
import hashlib
import re
from typing import Dict, List, Tuple

from typeguard import typechecked

from backend.apps.events.models import Event, WebWatchSource

FETCH_TIMEOUT_S = 20.0
MAX_KEPT_TEXT = 8000
MAX_EXCERPT = 400
ERROR_PREFIXES = ("HTTP error", "Error fetching", "Refused to fetch")


@typechecked
def p_normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:MAX_KEPT_TEXT]


@typechecked
def p_added_excerpt(before: str, after: str) -> str:
    before_words = before.split()
    after_words = after.split()
    matcher = difflib.SequenceMatcher(None, before_words, after_words, autojunk=False)
    added: List[str] = []
    for opcode in matcher.get_opcodes():
        op, j1, j2 = opcode[0], opcode[3], opcode[4]
        if op in ("insert", "replace"):
            added.extend(after_words[j1:j2])
        if len(added) > 120:
            break
    return " ".join(added)[:MAX_EXCERPT]


@typechecked
async def web_watch(source: WebWatchSource, cursor: Dict) -> Tuple[List[Event], Dict]:
    url = source.url.strip()
    if not url:
        return [], cursor
    from backend.apps.agents.tools.web import WebFetchTool

    parts = await asyncio.wait_for(
        WebFetchTool().execute({"url": url, "prompt": source.watch_for or "page content"}, None),
        timeout=FETCH_TIMEOUT_S,
    )
    text = "\n".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
    if not text or text.startswith(ERROR_PREFIXES):
        raise RuntimeError(text[:160] or f"empty response from {url}")
    normalized = p_normalize(text)
    digest = hashlib.sha256(normalized.encode()).hexdigest()
    new_cursor: Dict = {"url": url, "digest": digest, "text": normalized}
    prev_digest = cursor.get("digest") if cursor.get("url") == url else None
    if prev_digest is None or prev_digest == digest:
        return [], new_cursor
    added = p_added_excerpt(str(cursor.get("text", "")), normalized)
    watching = f" (watching for: {source.watch_for})" if source.watch_for.strip() else ""
    summary = f"Page changed: {url}{watching}"
    if added:
        summary += f"; new content: {added[:200]}"
    return [Event(
        source="web",
        event_type="page_changed",
        summary=summary,
        dedup_key=f"{url}:{digest}",
        payload={"url": url, "added": added},
    )], new_cursor
