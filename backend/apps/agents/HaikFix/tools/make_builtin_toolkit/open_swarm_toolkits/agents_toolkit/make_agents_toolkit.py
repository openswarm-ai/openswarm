from typing import Dict
from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.custom_handlers.make_create_agent_handler import (
    make_create_agent_handler, CreateAgentInput,
)
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.custom_handlers.make_invoke_agent_handler import (
    make_invoke_agent_handler, InvokeAgentInput,
)
from backend.apps.agents.HaikFix.Agent.Agent import Agent

def make_agents_toolkit(parent: Agent, agent_registry: Dict[str, Agent]) -> Toolkit:
    return Toolkit(
        name="agents",
        description="Tools for creating and invoking agents",
        tools=[
            SDK_MCP_Tool(
                name="CreateAgent",
                description="Spawn a sub-agent to handle a complex subtask",
                deferred=False,
                permission="allow",
                server_name="openswarm-agents",
                input_schema=CreateAgentInput,
                handler=make_create_agent_handler(parent),
            ),
            SDK_MCP_Tool(
                name="InvokeAgent",
                description="Invoke a copy of an existing agent with a new message, preserving full conversation context",
                deferred=False,
                permission="allow",
                server_name="openswarm-agents",
                input_schema=InvokeAgentInput,
                handler=make_invoke_agent_handler(agent_registry),
            ),
        ],
    )