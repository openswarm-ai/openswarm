from typing import Dict
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.agents_toolkit.handlers.make_create_agent_handler import (
    make_create_agent_handler, CreateAgentInput,
)
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.agents_toolkit.handlers.make_invoke_agent_handler import (
    make_invoke_agent_handler, InvokeAgentInput,
)
from backend.core.Agent.Agent import Agent

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