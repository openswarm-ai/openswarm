"""SessionExportable: an agent card on a shared dashboard. We carry the recipe
(name, model, mode, system prompt, allowed tools) AND the chat transcript so a
shared agent arrives with the conversation that produced it, that's the whole
point of sharing one. The transcript rides through the same scrub layer as every
payload, so any secret-shaped string in it is redacted before it leaves. We still
DROP runtime state, costs, the worktree path, and active_mcps: importing must
never silently grant tool access, per the gate. Its MCP/actions, provider, and
built-in mode become import requirements so the importer is walked through
enabling them. The dashboard re-points dashboard_id after import."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from ..exportable import DepRef, ExportContext, RemapTable
from ..models import EntityType, Requirement, RequirementKind

P_BUILTIN_MODES = {"agent", "ask", "plan", "view-builder", "skill-builder"}
# Transcript fields ride along so the shared agent keeps its history; ids inside
# (message ids, branch ids, their parent/fork refs) are self-consistent within
# the one session file, so they carry verbatim with no remap.
P_KEEP = (
    "name", "provider", "model", "mode", "system_prompt", "allowed_tools",
    "max_turns", "thinking_level",
    "messages", "branches", "active_branch_id", "tool_group_meta",
)


class SessionExportable:
    type = EntityType.session

    def __init__(self, sid: str, name: str, data: dict):
        self.local_id = sid
        self.name = name
        self.p_data = data

    @classmethod
    def load(cls, local_id: str) -> "SessionExportable | None":
        # Memory first, disk fallback, the same order duplicate_session uses.
        # The live session holds the freshest transcript; a disk-only read would
        # ship a stale one (missing the latest turns) or drop a just-created
        # agent that hasn't flushed yet, so its card vanishes from the bundle.
        from backend.apps.agents.agent_manager import agent_manager
        sess = agent_manager.sessions.get(local_id)
        if sess is not None:
            d = sess.model_dump(mode="json")
        else:
            from backend.apps.agents.manager.session.session_store import load_session_data
            d = load_session_data(local_id)
        if d is None:
            return None
        return cls(local_id, d.get("name") or "Agent", d)

    def serialize(self, ctx: ExportContext) -> dict:
        return {k: self.p_data.get(k) for k in P_KEEP if k in self.p_data}

    def files(self) -> dict[str, bytes]:
        return {}

    def dependencies(self) -> list[DepRef]:
        mode = self.p_data.get("mode")
        if mode and mode not in P_BUILTIN_MODES:
            return [DepRef(EntityType.mode, mode, "uses_mode")]
        return []

    def requirements(self) -> list[Requirement]:
        reqs: list[Requirement] = []
        for mcp in self.p_data.get("active_mcps") or []:
            reqs.append(Requirement(
                kind=RequirementKind.mcp_action, key=mcp, label=mcp,
                detail="An agent here uses this action.",
            ))
        mode = self.p_data.get("mode") or "agent"
        if mode in P_BUILTIN_MODES and mode != "agent":
            reqs.append(Requirement(
                kind=RequirementKind.builtin_mode, key=mode, label=f"{mode} mode",
                detail="A built-in mode an agent runs in.",
            ))
        provider = self.p_data.get("provider") or "anthropic"
        reqs.append(Requirement(
            kind=RequirementKind.api_key, key=provider, label=f"A {provider} model",
            detail="Set up this provider so the agents can run.",
        ))
        return reqs

    @classmethod
    def import_(cls, payload: dict, files: dict[str, bytes], remap: RemapTable) -> str:
        from backend.apps.agents.manager.session.session_store import save_session
        sid = uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        # Older bundles (made before transcripts were carried) have no messages;
        # fall back to a single empty main branch so the imported agent is valid.
        branches = payload.get("branches") or {
            "main": {"id": "main", "parent_branch_id": None, "fork_point_message_id": None, "created_at": now}
        }
        active_branch_id = payload.get("active_branch_id") or "main"
        if active_branch_id not in branches:
            active_branch_id = next(iter(branches), "main")
        doc = {
            "id": sid,
            "name": payload.get("name") or "Agent",
            "status": "completed",
            "provider": payload.get("provider") or "anthropic",
            "model": payload.get("model") or "sonnet",
            "mode": payload.get("mode") or "agent",
            "system_prompt": payload.get("system_prompt"),
            "allowed_tools": payload.get("allowed_tools") or [],
            "max_turns": payload.get("max_turns"),
            "thinking_level": payload.get("thinking_level") or "auto",
            "messages": payload.get("messages") or [],
            "branches": branches,
            "active_branch_id": active_branch_id,
            "tool_group_meta": payload.get("tool_group_meta") or {},
            "active_mcps": [],
            "dashboard_id": None,  # the dashboard import re-points this
            "browser_id": None,
            "parent_session_id": None,
            "created_at": now,
            "closed_at": now,
        }
        save_session(sid, doc)
        return sid

    @classmethod
    def rollback(cls, local_id: str) -> None:
        from backend.apps.agents.manager.session.session_store import delete_session_file
        delete_session_file(local_id)
