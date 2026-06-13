# Refusal/meta tells from aux label calls; any hit means "show the fallback, not this".
_REJECT_STARTS = ("i ", "i'm", "i'll", "i've", "as an", "sorry", "unfortunately", "please", "here")
_REJECT_ANYWHERE = ("cannot", "can't", "unable", "no information", "not enough", "need more", "provide more")


def clean_short_label(raw: str, max_words: int = 4, max_chars: int = 36) -> str:
    """Squeeze an aux-LLM reply into a safe short label: first line only, markdown
    stripped, word/char capped; returns "" when it smells like an answer or refusal
    so the caller falls back instead of showing 'I cannot...' as a title."""
    line = next((l.strip() for l in (raw or "").splitlines() if l.strip()), "")
    line = line.strip("\"'` ").lstrip("#*->• ").replace("**", "").replace("`", "")
    line = line.rstrip(" .,:;!").strip()
    low = line.lower()
    if not line or low.startswith(_REJECT_STARTS) or any(t in low for t in _REJECT_ANYWHERE):
        return ""
    label = " ".join(line.split()[:max_words])
    if len(label) > max_chars:
        label = label[:max_chars].rsplit(" ", 1)[0].rstrip(" .,:;!") or label[:max_chars]
    return label


def safe_resp_text(resp) -> str:
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
