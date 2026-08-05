"""Open the first item of the kind the task named, without asking a model to find it.

"Comment on the first post" is a RESPOND task, so the compose-URL table (which answers "where do I
CREATE one of these?") does not apply, and the aux navigator has to find the item by clicking around
a feed. That is where instagram kept going wrong: measured across four windows it scored 1/10, 3/5,
0/5 and 0/5, landing variously in the stories viewer, on a profile, or nowhere, because the feed's
first clickable thing is not reliably a post.

But a site already publishes what each link IS, in the link's own URL. Instagram posts live at /p/,
tiktok videos at /video/, youtube at /watch, reddit threads at /comments/. So when the task names a
content type, we can pick the first link of that type deterministically instead of hoping the model
picks it. One page evaluate plus one navigate, no aux turn.

Generalises by construction: the patterns are the same P_URL_CONTENT_TYPES the wrong-surface guard
already uses, so a URL that would be REFUSED downstream as the wrong kind can never be chosen here.
"""

import re
from typing import Optional

from typeguard import typechecked

from backend.apps.agents.browser import browser_send_parse

# "the first post", "the top video", "the first story". Ordinal words only: without one the task is
# about a specific named thing, and picking the first anything would be a guess.
P_FIRST_RE = re.compile(r"\b(first|top|latest|newest|most recent)\b", re.I)


@typechecked
def wanted_type(task: str) -> Optional[str]:
    """The content type this task wants the first of, or None.

    Requires BOTH an ordinal ("first", "top", "latest") and exactly one content-type word, so
    "comment on the first post" qualifies and "reply to Sarah's message" does not: the second names
    a specific target that a positional pick would get wrong.
    """
    if not task or not P_FIRST_RE.search(task):
        return None
    hits = [name for name, rx in browser_send_parse.P_TASK_CONTENT_TYPES if rx.search(task)]
    return hits[0] if len(hits) == 1 else None


@typechecked
def first_link_expression(content_type: str) -> str:
    """JS returning the first same-origin link whose URL says it is `content_type`, or "".

    Same-origin on purpose: a feed is full of outbound links, and following one off-site turns a
    "comment on the first post" into a visit to whatever an ad pointed at.
    """
    pattern = {
        "post": r"/(p|posts?|status)/",
        "video": r"/(watch|shorts)\b|/video/",
        "story": r"/stories?/",
        "message": r"/(direct|messages?)/",
    }.get(content_type, "")
    if not pattern:
        return ""
    return (
        "(() => { const rx = new RegExp(" + repr(pattern).replace("'", '"') + "); "
        "for (const a of document.querySelectorAll('a[href]')) { "
        "  let u; try { u = new URL(a.href, location.href); } catch (e) { continue; } "
        "  if (u.origin !== location.origin) continue; "
        "  if (rx.test(u.pathname)) return u.href; } "
        "return ''; })()"
    )
