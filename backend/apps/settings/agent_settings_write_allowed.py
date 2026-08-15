"""The one place that decides whether an agent may rewrite the user's Settings (ENG-284).

SettingsWrite was the only agent tool with no user-facing gate at all, and it is the tool that can
undo the others: an agent that can rewrite Settings can turn memory back on, swap the model, or
change a prompt, so gating it first is what makes the rest of the panel mean anything.

Read from BOTH the dispatch path (`/api/settings-meta/write`) and the tool-list builder, so the
switch cannot become the kind of toggle that is stored and never consulted. The tool list is the
polite half (an agent is not offered a tool it cannot use); the route is the half that is actually
load-bearing, because a stale tool list or a hand-rolled MCP client cannot get past it.

Defaults ON: this adds a way to say no, it does not take a capability away from anyone.
"""
from typing import Any

from typeguard import typechecked

REFUSAL_REASON = "SettingsWrite is turned off in Settings; ask the user to enable it or change this themselves"


@typechecked
def agent_settings_write_allowed(settings: Any) -> bool:
    """True when agents may write Settings. Anything but an explicit False is a yes."""
    return getattr(settings, "agent_settings_write_enabled", True) is not False
