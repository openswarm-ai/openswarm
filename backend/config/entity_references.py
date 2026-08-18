"""Every cross-entity id field on a backend model: what entity it points at, and where that
entity is resolved from an id.

OpenSwarm stores entities as JSON records that point at each other with bare strings. A workflow
holds `edit_agent_session_id`, an app record holds `workspace_id`, a dashboard card holds
`session_id`. Nothing at the type level says the referent exists, so a reader that forgets the miss
renders a blank instead of a designed empty state. This module is the one place that says what each
pointer means, and the `dangling-refs` linter check (linter/checks/dangling_refs.py) fails any new
`*_id` / `*_ids` field on a backend model that is not declared here.

Data only, no logic: nothing resolves a pointer for you. The `EntityStore` rows name the function
that does, and the linter checks those names still exist so a rename can't quietly rot this file.
"""

from __future__ import annotations

from enum import Enum
from typing import List

from pydantic import BaseModel, ConfigDict


class EntityKind(str, Enum):
    """A record type other records point at by id."""

    SESSION = "session"
    DASHBOARD = "dashboard"
    WORKFLOW = "workflow"
    WORKFLOW_RUN = "workflow_run"
    OUTPUT = "output"
    WORKSPACE = "workspace"
    CLOUD_WORKFLOW = "cloud_workflow"
    # A provider login in 9router's own db, not one of our JSON records.
    PROVIDER_CONNECTION = "provider_connection"


class EntityStore(BaseModel):
    """Where one entity kind is looked up by id, so a reader knows what a pointer resolves against."""

    model_config = ConfigDict(validate_assignment=True, frozen=True)

    kind: EntityKind
    module: str
    lookup: str


class EntityReference(BaseModel):
    """One id field on one backend model, and the entity kind it points at."""

    model_config = ConfigDict(validate_assignment=True, frozen=True)

    module: str
    model: str
    field: str
    target: EntityKind


ENTITY_STORES: List[EntityStore] = [
    EntityStore(kind=EntityKind.SESSION, module="backend.apps.agents.manager.session.session_store", lookup="load_session_data"),
    EntityStore(kind=EntityKind.DASHBOARD, module="backend.apps.dashboards.dashboards", lookup="load"),
    EntityStore(kind=EntityKind.WORKFLOW, module="backend.apps.workflows.storage", lookup="get_workflow"),
    # No get_run(run_id) exists, so a run is found by scanning the listing; a stale last_run_id just reads as "no run".
    EntityStore(kind=EntityKind.WORKFLOW_RUN, module="backend.apps.workflows.storage", lookup="list_all_runs"),
    EntityStore(kind=EntityKind.OUTPUT, module="backend.apps.outputs.workspace_io", lookup="load_output"),
    # A workspace is a folder on disk, not a record, so its only by-id lookup is the read route.
    EntityStore(kind=EntityKind.WORKSPACE, module="backend.apps.outputs.outputs", lookup="read_workspace"),
    # The one referent that does not live on this machine. preflight asks the cloud whether it still has the row; a miss renders as "nothing is running this", never as a silent blank.
    EntityStore(kind=EntityKind.CLOUD_WORKFLOW, module="backend.apps.workflows.cloud.client", lookup="preflight"),
    EntityStore(kind=EntityKind.PROVIDER_CONNECTION, module="backend.apps.nine_router.credential_store", lookup="read_credential"),
]

CROSS_ENTITY_REFERENCES: List[EntityReference] = [
    EntityReference(module="backend.apps.agents.core.models", model="AgentConfig", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.agents.core.models", model="AgentConfig", field="selected_app_output_ids", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.agents.core.models", model="AgentConfig", field="workflow_edit_id", target=EntityKind.WORKFLOW),
    EntityReference(module="backend.apps.agents.core.models", model="AgentConfig", field="workflow_run_id", target=EntityKind.WORKFLOW_RUN),
    EntityReference(module="backend.apps.agents.core.models", model="AgentSession", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.agents.core.models", model="AgentSession", field="parent_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.agents.events.AgentEvent", model="AgentEventBase", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.agents.events.AgentTurnEventEmitter", model="AgentTurnEventEmitter", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.agents.core.models", model="AgentSession", field="workflow_edit_id", target=EntityKind.WORKFLOW),
    EntityReference(module="backend.apps.agents.core.models", model="AgentSession", field="workflow_run_id", target=EntityKind.WORKFLOW_RUN),
    EntityReference(module="backend.apps.agents.core.models", model="ApprovalRequest", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.agents.manager.Messaging", model="QueuedMessage", field="selected_app_output_ids", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.agents.manager.streaming.HookContext", model="HookContext", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.dashboard_layout.models", model="CardPosition", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.dashboard_layout.models", model="ViewCardPosition", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.dashboards.models", model="BrowserCardPosition", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.dashboards.models", model="CardPosition", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.dashboards.models", model="DashboardLayout", field="expanded_session_ids", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.dashboards.models", model="ViewCardPosition", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.outputs.models", model="AgentCreateAppRequest", field="parent_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.outputs.models", model="Output", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.outputs.models", model="Output", field="workspace_id", target=EntityKind.WORKSPACE),
    EntityReference(module="backend.apps.outputs.models", model="OutputCreate", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.outputs.models", model="OutputCreate", field="workspace_id", target=EntityKind.WORKSPACE),
    EntityReference(module="backend.apps.outputs.models", model="OutputExecute", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.apps_sdk.apps_sdk", model="SpawnAgentRequest", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.apps_sdk.apps_sdk", model="SpawnAgentReply", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.apps_sdk.apps_sdk", model="ToolsListRequest", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.apps_sdk.apps_sdk", model="ToolCallRequest", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.apps_sdk.tool_grants", model="PendingGrant", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.outputs.models", model="OutputExecuteResult", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.outputs.models", model="OutputUpdate", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.outputs.models", model="OutputUpdate", field="workspace_id", target=EntityKind.WORKSPACE),
    EntityReference(module="backend.apps.outputs.models", model="PublishPreflightRequest", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.outputs.models", model="PublishRequest", field="output_id", target=EntityKind.OUTPUT),
    EntityReference(module="backend.apps.outputs.models", model="WorkspaceSeedRequest", field="workspace_id", target=EntityKind.WORKSPACE),
    EntityReference(module="backend.apps.skills.models", model="SkillWorkspaceSeedRequest", field="workspace_id", target=EntityKind.WORKSPACE),
    EntityReference(module="backend.apps.workflows.models", model="AskRunBody", field="run_id", target=EntityKind.WORKFLOW_RUN),
    EntityReference(module="backend.apps.workflows.models", model="MissedRun", field="workflow_id", target=EntityKind.WORKFLOW),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="cloud_workflow_id", target=EntityKind.CLOUD_WORKFLOW),
    EntityReference(module="backend.apps.workflows.cloud.credential_readiness", model="CredentialReadiness", field="connection_ids", target=EntityKind.PROVIDER_CONNECTION),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="edit_agent_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="last_run_id", target=EntityKind.WORKFLOW_RUN),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="last_test_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="schedule_agent_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="Workflow", field="source_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="WorkflowCreate", field="dashboard_id", target=EntityKind.DASHBOARD),
    EntityReference(module="backend.apps.workflows.models", model="WorkflowCreate", field="source_session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="WorkflowRun", field="session_id", target=EntityKind.SESSION),
    EntityReference(module="backend.apps.workflows.models", model="WorkflowRun", field="workflow_id", target=EntityKind.WORKFLOW),
]
