"""The SDK Stop hook: an end-of-turn render gate for App Builder (view-builder) sessions.
If the live preview failed to render, it blocks the stop with the error so the agent fixes it,
up to a retry cap, then lets the turn end. Operates on the HookContext; the dict returns are
the claude_agent_sdk Stop hook protocol, not internal state."""

import asyncio
import logging
from typing import Dict

from typeguard import typechecked

from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.view_builder_state import (
    VIEW_BUILDER_RENDER_MAX_RETRIES,
    view_builder_render_retry_counts,
    view_builder_dirty_sessions,
)

logger = logging.getLogger(__name__)


@typechecked
async def stop_hook(ctx: HookContext, input_data: dict, tool_use_id, context) -> Dict[str, object]:
    """End-of-turn render gate for App Builder sessions. Reads the
    browser-reported render-state of the preview; if the app fails
    to render, blocks with the error so the agent fixes it, up to
    MAX_RETRIES then lets the stop through."""
    session = ctx.session
    if session.mode != "view-builder":
        return {}
    if session.id not in view_builder_dirty_sessions:
        return {}
    from backend.apps.outputs.runtime import (
        manager as outputs_runtime_manager,
    )
    if outputs_runtime_manager.get(session.id) is None:
        return {}
    state, error_text = outputs_runtime_manager.get_render_state_for_workspace(session.id)
    waited = 0.0
    while state is None and waited < 5.0:
        await asyncio.sleep(0.25)
        waited += 0.25
        state, error_text = outputs_runtime_manager.get_render_state_for_workspace(session.id)

    if state != "error":
        view_builder_render_retry_counts.pop(session.id, None)
        view_builder_dirty_sessions.discard(session.id)
        return {}

    attempts = view_builder_render_retry_counts.get(session.id, 0)
    if attempts >= VIEW_BUILDER_RENDER_MAX_RETRIES:
        logger.warning(
            "view-builder preview still failing after %s attempts for session %s; allowing stop",
            attempts, session.id,
        )
        view_builder_render_retry_counts.pop(session.id, None)
        view_builder_dirty_sessions.discard(session.id)
        return {}

    view_builder_render_retry_counts[session.id] = attempts + 1
    logger.info(
        "view-builder render block (attempt %s/%s) for session %s",
        attempts + 1, VIEW_BUILDER_RENDER_MAX_RETRIES, session.id,
    )
    trimmed = error_text[-3000:] if len(error_text) > 3000 else error_text
    return {
        "decision": "block",
        "reason": (
            f"The preview failed to render (attempt {attempts + 1}/"
            f"{VIEW_BUILDER_RENDER_MAX_RETRIES}):\n\n"
            f"{trimmed}\n\n"
            "Fix this so the app renders before finishing; the user "
            "currently sees an error instead of the app."
        ),
    }
