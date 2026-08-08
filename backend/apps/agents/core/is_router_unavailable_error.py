"""Terminal shape of "our own router is down", kept beside the classifier it delegates to."""

import re

from typeguard import typechecked

from backend.apps.agents.core.error_classify import is_router_unreachable_error


@typechecked
def is_router_unavailable_error(text: str) -> bool:
    """True when the turn died because our own localhost router was down, either because the CLI
    could not reach it or because we refused to start at all. Distinct from
    `is_router_unreachable_error`, which is the narrower mid-turn "resume and carry on" case: this
    one is the terminal shape, and it exists so the envelope names a cause instead of shrugging
    'unclassified' at the one failure whose fix is entirely ours."""
    if not text.strip():
        return False
    if is_router_unreachable_error(text):
        return True
    return bool(re.search(
        r"9router\s+is\s+not\s+running"
        r"|9router\s+could\s+not\s+start"
        r"|9router.{0,30}not\s+ready",
        text,
        re.IGNORECASE,
    ))
