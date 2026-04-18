from backend.core.Agent.Agent import Agent
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.make_builtin_toolkit.make_builtin_toolkit import make_builtin_toolkit
from backend.apps.agents.COMMS_MANAGER.COMMS_MANAGER import CommsManager
from backend.apps.tools.tools import load_user_toolkit, load_builtin_permissions
from backend.apps.dashboards.dashboards import DASHBOARD_STORE
from typing import Dict, Optional
from typeguard import typechecked
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS


@typechecked
def p_apply_builtin_permission_overrides(toolkit: Toolkit, permissions: dict[str, TOOL_PERMISSIONS]) -> None:
    """Walk the toolkit tree and apply user-saved builtin permission overrides."""
    if toolkit.tools is not None:
        for tool in toolkit.tools:
            sdk_name: str = tool.to_sdk_args()
            if sdk_name in permissions:
                perm: TOOL_PERMISSIONS = permissions[sdk_name]
                tool.permission = perm
    if toolkit.nested_toolkits is not None:
        for nested in toolkit.nested_toolkits:
            p_apply_builtin_permission_overrides(nested, permissions)


@typechecked
async def build_agent_toolkit(agent: Agent, sessions: Dict[str, Agent], comms_manager: CommsManager) -> Toolkit:
    """Build the full toolkit tree: builtin tools + user-installed MCP tools.

    Also applies saved builtin permission overrides.
    """
    builtin_toolkit: Toolkit = make_builtin_toolkit(
        parent=agent, 
        agent_registry=sessions, 
        send_browser_command=comms_manager.send_browser_command,
        load_dashboard=DASHBOARD_STORE.load,
        save_dashboard=DASHBOARD_STORE.save,
    )
    user_toolkit: Optional[Toolkit] = await load_user_toolkit()

    full_toolkit: Optional[Toolkit] = None
    if user_toolkit is not None:
        full_toolkit = Toolkit(
            name="root",
            description="All available tools",
            nested_toolkits=[builtin_toolkit, user_toolkit],
        )
    else:
        full_toolkit = builtin_toolkit
    assert full_toolkit is not None, "Full toolkit should never be None"

    builtin_permissions: Optional[dict[str, TOOL_PERMISSIONS]] = load_builtin_permissions()
    if builtin_permissions is not None:
        p_apply_builtin_permission_overrides(
            toolkit=full_toolkit,
            permissions=builtin_permissions,
        )

    return full_toolkit