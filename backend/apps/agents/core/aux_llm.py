def _safe_resp_text(resp) -> str:
    """Extract text from an Anthropic-shape response, tolerating Gemini/OpenAI
    edge cases. Gemini through 9Router occasionally returns `content=[]` (e.g.
    safety stop, function-call-only turn) which makes `resp.content[0].text`
    raise `'NoneType' object is not subscriptable` and bubbles up as a
    fallback-required path. This walks the content list looking for the first
    text block and returns "" if none exists, so callers can decide their own
    fallback without a raw IndexError.
    """
    try:
        blocks = getattr(resp, "content", None) or []
        for b in blocks:
            t = getattr(b, "text", None)
            if isinstance(t, str) and t:
                return t
        return ""
    except Exception:
        return ""
