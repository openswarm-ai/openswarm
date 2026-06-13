"""
READ leg of the browser fast path: answer a public-page question with one
SSRF-guarded local fetch plus one cheap aux call, no browser and no
orchestrator. Anything short of a confident answer returns None and the
caller falls back to the full browser dispatch, so the worst case is the
old path, never a wrong answer from a thin read.
"""

import asyncio
import logging
import re
import time

logger = logging.getLogger(__name__)

P_ENTRY_RE = re.compile(r"^ENTRY:\s*(https?://\S+)", re.I | re.M)
P_MIN_PAGE_CHARS = 500
P_MAX_PAGE_CHARS = 24000
P_FETCH_ERROR_PREFIXES = ("HTTP error", "Error fetching", "Refused to fetch")

P_ANSWER_SYSTEM = (
    "Answer the user's request using ONLY the page text provided. Be direct and "
    "complete in a few sentences; quote exact titles/values from the page. End "
    "with nothing else.\n"
    "If the page text does not contain what the request needs, reply with "
    "exactly the single word INSUFFICIENT."
)


def extract_entry_url(brief: str) -> str:
    m = P_ENTRY_RE.search(brief or "")
    return m.group(1).rstrip(").,") if m else ""


def page_is_thin(text: str) -> bool:
    t = (text or "").strip()
    if not t or t.startswith(P_FETCH_ERROR_PREFIXES):
        return True
    body = t.split("\n\n", 1)[-1] if "\n\n" in t else t
    return len(body.strip()) < P_MIN_PAGE_CHARS


async def try_fast_read(prompt: str, brief: str, settings, primary_api: str | None) -> str | None:
    """Answer text on success; None means fall back to the browser leg."""
    entry = extract_entry_url(brief)
    if not entry:
        logger.info("[browser-fast-read] no ENTRY url in brief; browser fallback")
        return None
    try:
        from backend.apps.agents.tools.web import WebFetchTool

        t0 = time.monotonic()
        parts = await asyncio.wait_for(
            WebFetchTool().execute({"url": entry, "prompt": prompt}, None),
            timeout=12.0,
        )
        text = "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
        fetch_ms = int((time.monotonic() - t0) * 1000)
        if page_is_thin(text):
            logger.info(f"[browser-fast-read] thin/errored read of {entry} ({len(text)}ch in {fetch_ms}ms); browser fallback")
            return None
        logger.info(f"[browser-fast-read] fetched {entry}: {len(text)}ch in {fetch_ms}ms")

        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.agents.core.aux_llm import safe_resp_text

        aux_model, _ = await resolve_aux_model(
            settings, preferred_tier="haiku", primary_api=primary_api,
        )
        client = get_anthropic_client_for_model(settings, aux_model)
        t1 = time.monotonic()
        resp = await asyncio.wait_for(
            client.messages.create(
                model=aux_model,
                max_tokens=500,
                temperature=0,
                system=P_ANSWER_SYSTEM,
                messages=[{
                    "role": "user",
                    "content": f"Request: {prompt}\n\nPage text from {entry}:\n{text[:P_MAX_PAGE_CHARS]}",
                }],
            ),
            timeout=15.0,
        )
        answer = safe_resp_text(resp).strip()
        answer_ms = int((time.monotonic() - t1) * 1000)
        if not answer or answer.upper().startswith("INSUFFICIENT"):
            logger.info(f"[browser-fast-read] aux found page insufficient ({answer_ms}ms); browser fallback")
            return None
        logger.info(f"[browser-fast-read] answered in {answer_ms}ms ({len(answer)}ch, model={aux_model})")
        return f"{answer}\n\n(Source: {entry})"
    except Exception as e:
        logger.info(f"[browser-fast-read] failed ({e}); browser fallback")
        return None
