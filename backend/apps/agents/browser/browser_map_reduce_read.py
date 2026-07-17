"""
Map-reduce READ tier: answer a multi-source public read (a comparison, a
difference, a combine-across-pages) without the big-model loop. When the
single-page fast_read declined because the answer lives across TWO OR MORE
pages, one aux call decomposes the request into independent single-page
lookups, they run CONCURRENTLY (each is a fast_read-class fetch + extract), and
one aux reduce combines them.

Fail-open everywhere: not multi-source, a thin or insufficient source, or a
reduce that can't answer all return None and the caller falls to the browser
leg, so a partial read can never become a wrong answer. Lives only in the
classifier's READ branch (public pages), so it never taxes an authed read.
"""

import asyncio
import json
import logging
import os
import time

from backend.apps.agents.browser import browser_fast_read as fr

logger = logging.getLogger(__name__)

P_MAX_SOURCES = 4

P_DECOMPOSE_SYSTEM = (
    "Break the user's request into the MINIMUM set of independent factual "
    "lookups, each answerable from a SINGLE public web page. Return a JSON array "
    "of objects, each {\"q\": a self-contained question, \"url\": a starting URL "
    "(a direct page like https://en.wikipedia.org/wiki/NAME, or a search URL "
    "like https://www.google.com/search?q=...)}.\n"
    "Return 2 or more entries ONLY when the request genuinely needs different "
    "pages combined: a comparison, a difference, a sum, a 'both X and Y'. If a "
    "single page could answer it, return [].\n"
    "Never invent facts; only name the lookups. Output ONLY the JSON array."
)

P_REDUCE_SYSTEM = (
    "Answer the user's original request using ONLY the sub-answers provided, "
    "each gathered from its own page.\n"
    "First state each exact value. Then show the SINGLE arithmetic step the "
    "request needs (the subtraction, sum, or comparison). Then give the final "
    "answer. Your final number MUST equal the result of that step; never state a "
    "total or difference that disagrees with your own arithmetic.\n"
    "If the sub-answers do not together contain what the request needs, reply "
    "with exactly the single word INSUFFICIENT."
)


def enabled() -> bool:
    """Fail-open additive tier; default on, kill with OSW_MAP_REDUCE_READ=0."""
    return os.environ.get("OSW_MAP_REDUCE_READ", "1") != "0"


def parse_plan(text: str) -> list[tuple[str, str]]:
    """(question, url) pairs from the decompose JSON; [] on anything unparseable
    or single-source. Bounded to P_MAX_SOURCES so a runaway plan can't fan out."""
    s = (text or "").strip()
    i, j = s.find("["), s.rfind("]")
    if i < 0 or j <= i:
        return []
    try:
        arr = json.loads(s[i:j + 1])
    except (json.JSONDecodeError, ValueError):
        return []
    out: list[tuple[str, str]] = []
    for it in arr if isinstance(arr, list) else []:
        if isinstance(it, dict):
            q, url = str(it.get("q") or "").strip(), str(it.get("url") or "").strip()
            if q and url.startswith(("http://", "https://")):
                out.append((q, url))
    return out[:P_MAX_SOURCES]


async def p_fetch_and_extract(client, aux_model: str, q: str, url: str) -> str | None:
    """One source: fetch the page, aux-extract the answer to q, or None if the
    page is thin or insufficient (so the whole map-reduce fails open, never
    fabricates a missing piece)."""
    try:
        raw = await fr.fetch_raw(url)
        text = fr.strip_tags(raw)
        if fr.page_is_thin(text):
            text = await fr.fetch_page_text(url, q)
        if fr.page_is_thin(text):
            return None
        ans = await fr.ask_aux(
            client, aux_model, fr.P_ANSWER_SYSTEM,
            f"Request: {q}\n\nPage text from {url}:\n{text[:fr.P_MAX_PAGE_CHARS]}")
        if not ans or ans.upper().startswith("INSUFFICIENT"):
            return None
        return ans
    except Exception:
        return None


async def try_map_reduce_read(prompt: str, brief: str, settings, primary_api: str | None) -> str | None:
    """Answer text for a multi-source public read, or None (caller falls to the
    browser leg). Any missing piece returns None, so it never half-answers."""
    if not enabled():
        return None
    t0 = time.monotonic()
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model

        aux_model, _ = await resolve_aux_model(
            settings, preferred_tier="haiku", primary_api=primary_api)
        client = get_anthropic_client_for_model(settings, aux_model)

        plan_text = await fr.ask_aux(client, aux_model, P_DECOMPOSE_SYSTEM, f"Request: {prompt[:1200]}")
        plan = parse_plan(plan_text)
        if len(plan) < 2:
            return None
        logger.info(f"[browser-mapreduce] {len(plan)} sources: {[u for _, u in plan]}")

        subs = await asyncio.gather(*[p_fetch_and_extract(client, aux_model, q, u) for q, u in plan])
        if any(s is None for s in subs):
            logger.info(f"[browser-mapreduce] a source came back thin/insufficient in "
                        f"{int((time.monotonic() - t0) * 1000)}ms; browser fallback")
            return None

        joined = "\n\n".join(f"Sub-question: {q}\nAnswer (from {u}): {s}"
                             for (q, u), s in zip(plan, subs))
        final = await fr.ask_aux(client, aux_model, P_REDUCE_SYSTEM,
                                 f"Original request: {prompt}\n\n{joined}")
        if not final or final.upper().startswith("INSUFFICIENT"):
            logger.info(f"[browser-mapreduce] reduce insufficient in "
                        f"{int((time.monotonic() - t0) * 1000)}ms; browser fallback")
            return None
        logger.info(f"[browser-mapreduce] answered from {len(plan)} sources in "
                    f"{int((time.monotonic() - t0) * 1000)}ms")
        return f"{final}\n\n(Sources: {', '.join(u for _, u in plan)})"
    except Exception as e:
        logger.info(f"[browser-mapreduce] skipped ({e}); browser fallback")
        return None
