"""WorkflowExportable: shares a scheduled-task/workflow recipe (steps, schedule
shape, actions, model).

Safety: an imported workflow must never silently start running on someone else's
machine, so the schedule is forced off on import (the importer re-arms it). The
sharer's phone numbers (text/call escalation) are stripped as PII, and run
history / session + dashboard linkage are dropped."""
from __future__ import annotations

from backend.apps.swarm.exportable import DepRef, ExportContext, RemapTable
from backend.apps.swarm.models import EntityType, Requirement, RequirementKind
from backend.apps.workflows import storage
from backend.apps.workflows.models import Workflow

P_BUILTIN_MODES = {"agent", "ask", "plan", "view-builder", "skill-builder"}

# Run-state, machine-linkage, and identifiers that must not ride along.
P_DROP_FIELDS = {
    "id", "source_session_id", "dashboard_id", "edit_agent_session_id",
    "last_run_at", "last_run_status", "last_run_id", "next_run_at",
    "created_at", "updated_at", "cost_cap_usd_monthly",
}


def sanitize_workflow(data: dict) -> dict:
    out = {k: v for k, v in data.items() if k not in P_DROP_FIELDS}
    sched = dict(out.get("schedule") or {})
    if sched:
        sched["enabled"] = False
        sched["runs_count"] = 0
        sched["next_run_at"] = None
        sched["ends_at"] = None
        out["schedule"] = sched
    perms = []
    for tier in out.get("permissions") or []:
        t = dict(tier)
        t["phone"] = None  # the sharer's number; the importer sets their own
        perms.append(t)
    if perms:
        out["permissions"] = perms
    return out


class WorkflowExportable:
    type = EntityType.workflow

    def __init__(self, local_id: str, name: str, data: dict):
        self.local_id = local_id
        self.name = name
        self.p_data = data

    @classmethod
    def load(cls, local_id: str) -> "WorkflowExportable | None":
        wf = storage.get_workflow(local_id)
        if wf is None:
            return None
        data = wf.model_dump(mode="json")
        return cls(local_id, data.get("title") or "Untitled workflow", data)

    def serialize(self, ctx: ExportContext) -> dict:
        return sanitize_workflow(self.p_data)

    def files(self) -> dict[str, bytes]:
        return {}

    def dependencies(self) -> list[DepRef]:
        return []

    def requirements(self) -> list[Requirement]:
        reqs: list[Requirement] = []
        for name in (self.p_data.get("actions") or {}).get("configured_sets") or []:
            reqs.append(Requirement(
                kind=RequirementKind.mcp_action, key=name, label=name,
                detail="This workflow uses this action.",
            ))
        mode = self.p_data.get("mode") or "agent"
        if mode in P_BUILTIN_MODES and mode != "agent":
            reqs.append(Requirement(
                kind=RequirementKind.builtin_mode, key=mode, label=f"{mode} mode",
                detail="A built-in mode this workflow runs in.",
            ))
        provider = self.p_data.get("provider") or "anthropic"
        reqs.append(Requirement(
            kind=RequirementKind.api_key, key=provider, label=f"A {provider} model",
            detail="Set up this provider to run the workflow.",
        ))
        return reqs

    @classmethod
    def import_(cls, payload: dict, files: dict[str, bytes], remap: RemapTable) -> str:
        clean = sanitize_workflow(payload)
        clean.pop("id", None)  # fresh id via the model's default_factory
        wf = Workflow(**clean)
        storage.save_workflow(wf)
        return wf.id

    @classmethod
    def rollback(cls, local_id: str) -> None:
        try:
            storage.delete_workflow(local_id)
        except Exception:
            pass
