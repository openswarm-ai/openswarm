"""
Schema-driven page extraction (the Stagehand `extract` port, on our terms).

One cheap aux call turns the current page's text into the JSON the agent asked
for, so the main model never spends context on 15k chars of raw page text. The
aux model is whatever cheap tier the user's provider offers (registry-resolved
by the caller); nothing here hardcodes a model.
"""

import json
import logging
import re

logger = logging.getLogger(__name__)

P_MAX_PAGE_CHARS = 12000
P_MAX_OUT_TOKENS = 1200
P_MAX_SCHEMA_CHARS = 2000


def p_first_json(text: str) -> str:
    """The model's output minus any prose/fences around the JSON, or ''."""
    cleaned = re.sub(r"```(?:json)?|```", "", text or "")
    m = re.search(r"\{.*\}|\[.*\]", cleaned, re.DOTALL)
    if not m:
        return ""
    try:
        return json.dumps(json.loads(m.group(0)), ensure_ascii=False)
    except Exception:
        return ""


async def extract_structured(
    aux_client, aux_model, page_text: str, instruction: str, schema: dict | None = None,
) -> str:
    """Compact JSON string per the instruction (+ optional schema), or '' on
    any miss so the caller can hand the agent an honest fallback."""
    if not aux_client or not aux_model or not page_text:
        return ""
    shape = (
        f"Return JSON matching this schema exactly:\n{json.dumps(schema)[:P_MAX_SCHEMA_CHARS]}"
        if isinstance(schema, dict) and schema else "Return one compact JSON object."
    )
    prompt = (
        "Extract data from this web page text.\n"
        f"What to extract: {instruction}\n{shape}\n"
        "Output ONLY the JSON, no prose, no code fences. Use only what is on the "
        'page, never guess. If the requested data is not on the page, output '
        '{"not_found": true, "reason": "<one short line>"}.\n\n'
        f"PAGE TEXT:\n{page_text[:P_MAX_PAGE_CHARS]}"
    )
    try:
        resp = await aux_client.messages.create(
            model=aux_model, max_tokens=P_MAX_OUT_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") for b in (resp.content or []))
        return p_first_json(text)
    except Exception as e:
        logger.debug(f"[browser-extract] aux extraction failed: {e}")
        return ""
