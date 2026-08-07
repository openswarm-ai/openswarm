import re

from typeguard import typechecked


@typechecked
def extract_reset_hint(text: str) -> str:
    """Pull a human reset phrase ('at 7:42 AM', 'in 2h 30m', 'after 1m 59s') out of
    a provider usage error so we can tell the user when their limit comes back.
    """
    if not text:
        return ""
    m = re.search(
        r"(?:try\s+again|resets?|reset)\s+((?:in|at|after)\s+[^.\n)]{1,40})",
        text,
        re.IGNORECASE,
    )
    return m.group(1).strip() if m else ""
