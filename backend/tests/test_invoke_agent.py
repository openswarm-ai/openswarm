"""InvokeAgent (agent-to-agent) binding invariant.

The bug: invoke_agent carried a spurious @staticmethod on a def whose first
parameter is self, so the instance never bound and EVERY call raised
TypeError("missing 1 required positional argument: 'self'"), which
/api/invoke-agent/run surfaced as a 500 to the calling agent.

The seal: call it exactly the way the route does (instance, all-keyword args)
and pin that it reaches the method body: an unknown session must raise the
body's ValueError, never a binding TypeError.
"""

import asyncio

import pytest

import backend.apps.agents.manager.AgentLaunch as agent_launch_module
from backend.apps.agents.agent_manager import agent_manager


def test_invoke_agent_binds_as_instance_method(monkeypatch) -> None:
    monkeypatch.setattr(agent_launch_module, "load_session_data", lambda sid: None)

    async def run() -> None:
        with pytest.raises(ValueError, match="not found"):
            await agent_manager.invoke_agent(
                source_session_id="no-such-session",
                message="what did you do?",
            )

    asyncio.run(run())
