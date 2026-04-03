"""Pure prompt-building helpers.

All functions are stateless — they accept data as parameters and return
strings.  No imports from ``apps/`` or any external stores.
"""

from typing import Optional, List
from typeguard import typechecked

@typechecked
def compose_system_prompt(
    global_default: Optional[str] = None,
    mode_prompt: Optional[str] = None,
    session_prompt: Optional[str] = None,
    connected_tools_ctx: Optional[str] = None,
    browser_ctx: Optional[str] = None,
) -> Optional[str]:
    """Layer multiple prompt sources into one system prompt.

    Order matters — earlier layers provide base context, later layers
    override or augment.
    """
    parts: List[str] = [p for p in (
        global_default,
        mode_prompt,
        session_prompt,
        connected_tools_ctx,
        browser_ctx,
    ) if p]
    return "\n\n".join(parts) if parts else None