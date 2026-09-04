"""One rule for what counts as an app icon, shared by the meta.json sync and the API.

An icon is a single emoji symbol. The model's default ("view_quilt") is a Material icon NAME
that nothing renders, so names and words are rejected rather than stored; the renderer's
`appIconGlyph` applies the same rule, so the two can never disagree about a value.
"""
from __future__ import annotations

import re

WORDISH = re.compile(r"[\w]", re.UNICODE)


def glyph_icon(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    g = value.strip()
    if not g or len(g) > 4:
        return None
    return None if WORDISH.search(g) else g
