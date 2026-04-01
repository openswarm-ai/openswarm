import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime
from uuid import uuid4
from typing import Optional

from backend.apps.agents.models import (
    AgentConfig, AgentSession, Message, MessageBranch, ApprovalRequest, ToolGroupMeta,
)
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.modes.modes import load_mode
from backend.apps.outputs.outputs import _load_all as load_all_outputs
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    _sanitize_server_name,
    derive_mcp_config,
    load_builtin_permissions,
    refresh_google_token,
)
from backend.config.paths import SESSIONS_DIR

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


def _save_session(session_id: str, doc_data: dict):
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    with open(os.path.join(SESSIONS_DIR, f"{session_id}.json"), "w") as f:
        json.dump(doc_data, f, indent=2)


def _load_session_data(session_id: str) -> dict | None:
    path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _delete_session_file(session_id: str):
    path = os.path.join(SESSIONS_DIR, f"{session_id}.json")
    if os.path.exists(path):
        os.remove(path)


def _load_all_session_data() -> list[tuple[str, dict]]:
    results = []
    if not os.path.exists(SESSIONS_DIR):
        return results
    for fname in os.listdir(SESSIONS_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(SESSIONS_DIR, fname)) as f:
                results.append((fname[:-5], json.load(f)))
    return results

FULL_TOOLS = [
    "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
    "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite",
    "EnterPlanMode", "ExitPlanMode", "EnterWorktree",
    "TaskOutput", "TaskStop",
    "CronCreate", "CronList", "CronDelete",
    "RenderOutput",
    "InvokeAgent",
    "Agent",
]

def _get_denied_tool_names(tool) -> set[str]:
    """Return the set of MCP sub-tool names whose permission is 'deny'."""
    return {
        key for key, value in tool.tool_permissions.items()
        if not key.startswith("_") and value == "deny"
    }


def _get_all_known_tool_names(tool) -> set[str]:
    """Return all known sub-tool names for an MCP tool (from _tool_descriptions)."""
    return set(tool.tool_permissions.get("_tool_descriptions", {}).keys())


def _is_fully_denied(tool) -> bool:
    """True when every known sub-tool on this MCP server is set to 'deny'."""
    known = _get_all_known_tool_names(tool)
    if not known:
        return False
    return known <= _get_denied_tool_names(tool)


def get_all_tool_names() -> list[str]:
    """FULL_TOOLS + installed MCP tool identifiers (mcp:<tool_name>).

    Builtin tools set to 'deny' and MCP servers whose every sub-tool
    is denied are excluded.
    """
    builtin_perms = load_builtin_permissions()
    builtin_tools = [
        t for t in FULL_TOOLS
        if builtin_perms.get(t, "always_allow") != "deny"
    ]
    mcp_names = [
        f"mcp:{t.name}"
        for t in load_all_tools()
        if t.mcp_config
        and t.enabled
        and t.auth_status in ("configured", "connected")
        and not _is_fully_denied(t)
    ]
    return builtin_tools + mcp_names


# Sentinel value placed in a session queue to shut the loop down cleanly.
_QUEUE_STOP = object()

# How long (seconds) a session loop waits idle before self-terminating.
_SESSION_IDLE_TIMEOUT = 30 * 60  # 30 minutes


class AgentManager:
    def __init__(self):
        self.sessions: dict[str, AgentSession] = {}
        # Long-lived per-session loop tasks (one per open session).
        self.tasks: dict[str, asyncio.Task] = {}
        # Short-lived tasks: the currently-running query inside a session loop.
        self.run_tasks: dict[str, asyncio.Task] = {}
        # Message queues – send_message() enqueues here, _session_loop() dequeues.
        self.message_queues: dict[str, asyncio.Queue] = {}
    
    def _resolve_mode(self, mode_id: str) -> tuple[list[str], str | None, str | None]:
        """Return (tools, system_prompt, default_folder) resolved from the mode store."""
        mode_def = load_mode(mode_id)
        if mode_def:
            tools = mode_def.tools if mode_def.tools is not None else get_all_tool_names()
            return tools, mode_def.system_prompt, mode_def.default_folder
        return get_all_tool_names(), None, None

    async def _build_mcp_servers(self, allowed_tools: list[str]) -> dict:
        """Build the mcp_servers dict for ClaudeAgentOptions from installed MCP tools.

        Servers whose every sub-tool is denied are skipped entirely.
        """
        mcp_servers: dict = {}
        all_tools = load_all_tools()
        mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]

        for tool in mcp_tools:
            tool_ref = f"mcp:{tool.name}"
            if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
                if not any(tool_ref == at for at in allowed_tools):
                    continue

            if _is_fully_denied(tool):
                continue

            if tool.auth_type == "oauth2" and tool.auth_status == "connected":
                await refresh_google_token(tool)

            config = derive_mcp_config(tool)
            if config:
                server_name = _sanitize_server_name(tool.name)
                mcp_servers[server_name] = config

        return mcp_servers

    def _build_connected_tools_context(self, allowed_tools: list[str]) -> str | None:
        """Build a context block describing connected MCP tools and their accounts.

        Tools set to 'deny' and fully-denied servers are excluded.
        """
        all_tools = load_all_tools()
        mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]

        sections = []
        for tool in mcp_tools:
            tool_ref = f"mcp:{tool.name}"
            if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
                continue

            if _is_fully_denied(tool):
                continue

            server_name = _sanitize_server_name(tool.name)
            denied = _get_denied_tool_names(tool)
            tool_descs = {
                k: v for k, v in tool.tool_permissions.get("_tool_descriptions", {}).items()
                if k not in denied
            }
            if not tool_descs:
                continue

            lines = [f"MCP Server: {server_name}"]
            lines.append(f"  Status: {tool.auth_status}")

            if tool.connected_account_email:
                lines.append(f"  Connected account: {tool.connected_account_email}")
                lines.append(
                    f"  IMPORTANT: When calling tools from this server that require an email "
                    f"parameter (e.g. user_google_email, user_email), always use "
                    f"\"{tool.connected_account_email}\" automatically — do NOT ask the user."
                )

            tool_names = list(tool_descs.keys())
            if tool_names:
                lines.append(f"  Available tools ({len(tool_names)}): {', '.join(tool_names[:15])}")
                if len(tool_names) > 15:
                    lines.append(f"    ... and {len(tool_names) - 15} more")

            sections.append("\n".join(lines))

        if not sections:
            return None
        return (
            "<connected_mcp_tools>\n"
            "The following MCP tool servers are connected and available. "
            "Use them directly when relevant to the user's request.\n\n"
            + "\n\n".join(sections)
            + "\n</connected_mcp_tools>"
        )

    def _build_outputs_context(self) -> str | None:
        """Build a context block describing available Outputs the agent can render."""
        import json as _json
        all_outputs = load_all_outputs()
        if not all_outputs:
            return None

        sections = []
        for out in all_outputs:
            lines = [f"- **{out.name}** (id: `{out.id}`)"]
            if out.description:
                lines.append(f"  Description: {out.description}")
            schema_str = _json.dumps(out.input_schema, indent=2)
            lines.append(f"  Input schema:\n```json\n{schema_str}\n```")
            sections.append("\n".join(lines))

        return (
            "<available_views>\n"
            "The following reusable View artifacts are available. "
            "Use the RenderOutput tool to invoke one by providing its output_id "
            "and the required input_data matching its schema.\n\n"
            + "\n\n".join(sections)
            + "\n</available_views>"
        )

    def _build_browser_context(self, dashboard_id: str | None, selected_browser_ids: list[str] | None = None) -> str | None:
        """Build a context block listing browser cards and delegation instructions.

        Only browser cards explicitly selected by the user are included.
        If none are selected, no browser card details are exposed.
        """
        if not dashboard_id:
            return None
        try:
            from backend.apps.dashboards.dashboards import _load as load_dashboard
            dashboard = load_dashboard(dashboard_id)
        except Exception:
            return None
        raw = dashboard.model_dump(mode="json")
        browser_cards = raw.get("layout", {}).get("browser_cards", {})

        lines = [
            "<browser_agent_instructions>",
            "You have access to browser automation through the CreateBrowserAgent, BrowserAgent, and BrowserAgents tools.",
            "",
            "- **CreateBrowserAgent(task, url?)**: Create a new browser card and run a task on it. "
            "Use this when you need a fresh browser. Optionally provide a starting URL.",
            "- **BrowserAgent(browser_id, task)**: Delegate a task to an existing browser card. "
            "The browser agent will autonomously navigate, click, type, and interact with the page, then return a summary and screenshot.",
            "- **BrowserAgents(tasks)**: Run multiple browser tasks in parallel on existing browser cards. "
            "Each task requires a browser_id.",
            "",
            "You do NOT have direct access to low-level browser tools (click, type, screenshot, etc.). "
            "Instead, describe what you want accomplished and the browser agent will handle the details.",
        ]

        if browser_cards and selected_browser_ids:
            visible_cards = [
                card for card in browser_cards.values()
                if card.get("browser_id", "") in selected_browser_ids
            ]
            if visible_cards:
                lines.append("")
                lines.append("The user selected these browser cards for you to work with:")
                for card in visible_cards:
                    bid = card.get("browser_id", "")
                    tabs = card.get("tabs", [])
                    active_tab_id = card.get("activeTabId", "")
                    active_tab = next((t for t in tabs if t.get("id") == active_tab_id), None)
                    url = (active_tab or {}).get("url", card.get("url", ""))
                    title = (active_tab or {}).get("title", "")
                    lines.append(f"- browser_id: \"{bid}\"")
                    if title:
                        lines.append(f"  Title: {title}")
                    if url:
                        lines.append(f"  URL: {url}")

        lines.append("</browser_agent_instructions>")
        return "\n".join(lines)

    def _get_pre_selected_browser_ids(self, dashboard_id: str | None) -> list[str]:
        """Return browser_ids of all browser cards currently on the dashboard."""
        if not dashboard_id:
            return []
        try:
            from backend.apps.dashboards.dashboards import _load as load_dashboard
            dashboard = load_dashboard(dashboard_id)
        except Exception:
            return []
        raw = dashboard.model_dump(mode="json")
        browser_cards = raw.get("layout", {}).get("browser_cards", {})
        return [card.get("browser_id", "") for card in browser_cards.values() if card.get("browser_id")]

    def _compose_system_prompt(self, default_prompt: str | None, mode_prompt: str | None, session_prompt: str | None, connected_tools_ctx: str | None = None, outputs_ctx: str | None = None, browser_ctx: str | None = None) -> str | None:
        parts = [p for p in (default_prompt, mode_prompt, session_prompt, connected_tools_ctx, outputs_ctx, browser_ctx) if p]
        return "\n\n".join(parts) if parts else None

    async def launch_agent(self, config: AgentConfig) -> AgentSession:
        session_id = uuid4().hex

        mode_tools, _, mode_folder = self._resolve_mode(config.mode)
        tools = mode_tools

        global_settings = load_settings()
        effective_cwd = (
            config.target_directory
            or mode_folder
            or global_settings.default_folder
            or os.path.expanduser("~")
        )

        if config.mode in ("view-builder", "skill-builder") and not config.target_directory:
            effective_cwd = os.path.join(effective_cwd, session_id)

        os.makedirs(effective_cwd, exist_ok=True)

        session = AgentSession(
            id=session_id,
            name=config.name,
            model=config.model,
            mode=config.mode,
            system_prompt=config.system_prompt,
            allowed_tools=tools,
            max_turns=config.max_turns,
            cwd=effective_cwd,
            dashboard_id=config.dashboard_id,
        )
        self.sessions[session_id] = session
        
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })
        
        return session

    def _resolve_context_paths(self, context_paths: list | None) -> str:
        """Read file contents / directory trees for attached context paths."""
        if not context_paths:
            return ""
        sections = []
        for cp in context_paths:
            path = cp.get("path", "")
            cp_type = cp.get("type", "file")
            if not path or not os.path.exists(path):
                sections.append(f"[Context: {path} — not found]")
                continue
            if cp_type == "file" and os.path.isfile(path):
                try:
                    with open(path, "r", errors="replace") as f:
                        content = f.read(512_000)  # ~500KB cap per file
                    sections.append(
                        f"<context_file path=\"{path}\">\n{content}\n</context_file>"
                    )
                except Exception as e:
                    sections.append(f"[Context: {path} — error reading: {e}]")
            elif cp_type == "directory" and os.path.isdir(path):
                tree_lines = self._build_dir_tree(path, max_depth=4)
                sections.append(
                    f"<context_directory path=\"{path}\">\n{chr(10).join(tree_lines)}\n</context_directory>"
                )
            else:
                sections.append(f"[Context: {path} — type mismatch]")
        return "\n\n".join(sections)

    def _build_dir_tree(self, root: str, max_depth: int = 4, prefix: str = "") -> list[str]:
        """Build a recursive directory tree listing."""
        lines = []
        try:
            entries = sorted(os.listdir(root))
        except PermissionError:
            return [f"{prefix}[permission denied]"]
        dirs = [e for e in entries if not e.startswith(".") and os.path.isdir(os.path.join(root, e))]
        files = [e for e in entries if not e.startswith(".") and os.path.isfile(os.path.join(root, e))]
        for f in files:
            lines.append(f"{prefix}{f}")
        for d in dirs:
            lines.append(f"{prefix}{d}/")
            if max_depth > 1:
                sub = self._build_dir_tree(os.path.join(root, d), max_depth - 1, prefix + "  ")
                lines.extend(sub)
        return lines

    def _resolve_forced_tools(self, forced_tools: list[str] | None) -> str:
        """Build a context block describing explicitly requested tools."""
        if not forced_tools:
            return ""
        from backend.apps.tools_lib.models import BUILTIN_TOOLS
        desc_map: dict[str, str] = {t.name: t.description for t in BUILTIN_TOOLS}
        tool_to_server: dict[str, str] = {}
        tool_to_email: dict[str, str] = {}
        for t in load_all_tools():
            if not t.enabled or not t.tool_permissions:
                continue
            tool_descs = t.tool_permissions.get("_tool_descriptions", {})
            server_name = _sanitize_server_name(t.name)
            for tn, td in tool_descs.items():
                desc_map[tn] = td
                tool_to_server[tn] = server_name
                if t.connected_account_email:
                    tool_to_email[tn] = t.connected_account_email

        lines = []
        for name in forced_tools:
            desc = desc_map.get(name, "")
            line = f"- {name}: {desc}" if desc else f"- {name}"
            server = tool_to_server.get(name)
            if server:
                line += f"\n  (MCP server: {server})"
            email = tool_to_email.get(name)
            if email:
                line += f"\n  (connected account: {email} — use this for any email parameter)"
            lines.append(line)

        return (
            "<forced_tools>\n"
            "The user explicitly requested these tools be used. "
            "Prioritize using them to address the user's request.\n"
            + "\n".join(lines)
            + "\n</forced_tools>"
        )

    def _resolve_attached_skills(self, attached_skills: list | None) -> str:
        """Build a context block injecting attached skill content into the prompt."""
        if not attached_skills:
            return ""
        sections = []
        for skill in attached_skills:
            name = skill.get("name", "Unknown")
            content = skill.get("content", "")
            if content:
                sections.append(f"[Using skill: {name}]\n\n{content}")
        return "\n\n".join(sections)

    def _build_prompt_content(self, prompt: str, images: list | None = None, context_paths: list | None = None, forced_tools: list[str] | None = None, attached_skills: list | None = None):
        """Build message content with optional image blocks, context, and forced tools for the Claude API."""
        context_text = self._resolve_context_paths(context_paths)
        forced_tools_text = self._resolve_forced_tools(forced_tools)
        skills_text = self._resolve_attached_skills(attached_skills)

        parts = [p for p in (forced_tools_text, context_text, skills_text, prompt) if p]
        full_prompt = "\n\n".join(parts)

        if not images:
            return full_prompt
        content = [{"type": "text", "text": full_prompt}]
        for img in images:
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.get("media_type", "image/png"),
                    "data": img["data"],
                },
            })
        return content

    async def _session_loop(self, session_id: str) -> None:
        """Long-lived per-session task.

        Reads (prompt_kwargs, extras) tuples from the session's message queue
        and runs _run_agent_loop for each one sequentially.  Exits after
        _SESSION_IDLE_TIMEOUT seconds of inactivity, or when a _QUEUE_STOP
        sentinel is enqueued (close/delete).
        """
        queue = self.message_queues.get(session_id)
        if queue is None:
            return
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=_SESSION_IDLE_TIMEOUT)
                except asyncio.TimeoutError:
                    logger.info(f"Session {session_id} loop idle-timeout, shutting down.")
                    break

                if item is _QUEUE_STOP:
                    break

                kwargs = item
                run_task = asyncio.create_task(
                    self._run_agent_loop(session_id, **kwargs)
                )
                self.run_tasks[session_id] = run_task
                try:
                    await run_task
                except asyncio.CancelledError:
                    # stop_agent() cancelled the run; loop stays alive for next msg
                    pass
                finally:
                    self.run_tasks.pop(session_id, None)
        except asyncio.CancelledError:
            # The whole loop was cancelled (close/delete).
            run = self.run_tasks.pop(session_id, None)
            if run and not run.done():
                run.cancel()
        finally:
            self.message_queues.pop(session_id, None)

    def _ensure_session_loop(self, session_id: str) -> None:
        """Create the queue and long-lived loop task for a session if not running."""
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return  # already alive
        queue: asyncio.Queue = asyncio.Queue()
        self.message_queues[session_id] = queue
        loop_task = asyncio.create_task(self._session_loop(session_id))
        self.tasks[session_id] = loop_task

    async def _run_agent_loop(self, session_id: str, prompt: str, images: list | None = None, context_paths: list | None = None, forced_tools: list[str] | None = None, attached_skills: list | None = None, fork_session: bool = False, selected_browser_ids: list[str] | None = None):
        """Run the Claude Agent SDK query loop for a session."""
        session = self.sessions.get(session_id)
        if not session:
            return
        
        prompt_content = self._build_prompt_content(prompt, images, context_paths, forced_tools, attached_skills)

        try:
            from claude_agent_sdk import (
                query, ClaudeAgentOptions, AssistantMessage, ResultMessage,
            )
            from claude_agent_sdk.types import (
                HookMatcher, PermissionResultAllow, PermissionResultDeny,
                TextBlock, ToolUseBlock, StreamEvent,
            )
        except ImportError:
            logger.warning("claude_agent_sdk not installed, running in mock mode")
            await self._run_mock_agent(session_id, prompt)
            return

        session.status = "running"
        
        _builtin_perms = load_builtin_permissions()

        def _get_effective_policy(tool_name: str) -> str:
            """Return 'always_allow', 'deny', or 'ask' for any tool."""
            if tool_name in _builtin_perms:
                return _builtin_perms[tool_name]

            import re as _re

            bm = _re.match(r"mcp__openswarm-browser-agent__(.+)", tool_name)
            if bm:
                return _builtin_perms.get(bm.group(1), "always_allow")

            im = _re.match(r"mcp__openswarm-invoke-agent__(.+)", tool_name)
            if im:
                return _builtin_perms.get(im.group(1), "always_allow")

            m = _re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", tool_name)
            if m:
                server_slug, mcp_tool_name = m.group(1), m.group(2)
                for t in load_all_tools():
                    if not t.mcp_config or not t.enabled:
                        continue
                    if _sanitize_server_name(t.name) == server_slug:
                        return t.tool_permissions.get(mcp_tool_name, "ask")
            return "always_allow"

        async def _request_user_approval(tool_name: str, tool_input) -> dict:
            """Send an approval request via WebSocket and wait for the user's decision."""
            safe_input = tool_input if isinstance(tool_input, dict) else {}
            request_id = uuid4().hex
            approval_req = ApprovalRequest(
                id=request_id,
                session_id=session_id,
                tool_name=tool_name,
                tool_input=safe_input,
            )
            session.pending_approvals.append(approval_req)
            session.status = "waiting_approval"

            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "waiting_approval",
            })

            decision = await ws_manager.send_approval_request(
                session_id, request_id, tool_name, safe_input
            )

            session.pending_approvals = [
                a for a in session.pending_approvals if a.id != request_id
            ]
            session.status = "running"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "running",
            })
            return decision

        async def can_use_tool(tool_name, input_data, context):
            if tool_name != "AskUserQuestion":
                policy = _get_effective_policy(tool_name)
                if policy == "always_allow":
                    return PermissionResultAllow(updated_input=input_data)
                if policy == "deny":
                    return PermissionResultDeny(message="Tool denied by permission policy")

            decision = await _request_user_approval(tool_name, input_data)
            if decision.get("behavior") == "allow":
                return PermissionResultAllow(
                    updated_input=decision.get("updated_input", input_data)
                )
            return PermissionResultDeny(
                message=decision.get("message", "User denied this action")
            )

        tool_start_times: dict[str, float] = {}

        async def pre_tool_hook(input_data, tool_use_id, context):
            tool_name = input_data.get("tool_name", "")
            hook_event = input_data.get("hook_event_name", "PreToolUse")

            if tool_name and tool_name != "AskUserQuestion":
                policy = _get_effective_policy(tool_name)

                if policy == "deny":
                    return {
                        "hookSpecificOutput": {
                            "hookEventName": hook_event,
                            "permissionDecision": "deny",
                            "permissionDecisionReason": "Tool denied by permission policy",
                        }
                    }

                if policy == "ask":
                    tool_input = input_data.get("tool_input", {})
                    decision = await _request_user_approval(tool_name, tool_input)

                    if decision.get("behavior") == "allow":
                        if tool_use_id:
                            tool_start_times[tool_use_id] = time.time()
                        return {
                            "hookSpecificOutput": {
                                "hookEventName": hook_event,
                                "permissionDecision": "allow",
                            }
                        }
                    return {
                        "hookSpecificOutput": {
                            "hookEventName": hook_event,
                            "permissionDecision": "deny",
                            "permissionDecisionReason": decision.get("message", "User denied this action"),
                        }
                    }

            if tool_use_id:
                tool_start_times[tool_use_id] = time.time()
            return {}

        async def post_tool_hook(input_data, tool_use_id, context):
            elapsed_ms = None
            if tool_use_id and tool_use_id in tool_start_times:
                elapsed_ms = int((time.time() - tool_start_times.pop(tool_use_id)) * 1000)

            raw_response = input_data.get("tool_response", "")

            if isinstance(raw_response, list) and raw_response:
                text_parts = [
                    block.get("text", "")
                    for block in raw_response
                    if isinstance(block, dict) and block.get("type") == "text"
                ]
                if text_parts:
                    raw_response = "\n".join(text_parts) if len(text_parts) > 1 else text_parts[0]

            if isinstance(raw_response, str):
                content = raw_response
            else:
                try:
                    import json as _json
                    content = _json.dumps(raw_response, indent=2, default=str)
                except Exception:
                    content = str(raw_response)

            result_payload = {"text": content}
            hook_tool_name = input_data.get("tool_name", "")
            if hook_tool_name:
                result_payload["tool_name"] = hook_tool_name
            if elapsed_ms is not None:
                result_payload["elapsed_ms"] = elapsed_ms

            if hook_tool_name == "Agent":
                tool_input = input_data.get("tool_input", {})
                agent_prompt = tool_input.get("prompt", tool_input.get("task", ""))

                sub_text = content
                sub_cost = 0.0
                sub_tokens = {"input": 0, "output": 0}
                sub_model = session.model
                if isinstance(raw_response, dict):
                    blocks = raw_response.get("content")
                    if isinstance(blocks, list):
                        parts = [
                            b.get("text", "")
                            for b in blocks
                            if isinstance(b, dict) and b.get("type") == "text"
                        ]
                        if parts:
                            sub_text = "\n".join(parts) if len(parts) > 1 else parts[0]
                    elif isinstance(raw_response.get("text"), str):
                        sub_text = raw_response["text"]
                    usage = raw_response.get("usage", {})
                    if isinstance(usage, dict):
                        sub_tokens["input"] = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
                        sub_tokens["output"] = usage.get("output_tokens", 0)
                    if raw_response.get("model"):
                        sub_model = raw_response["model"]

                sub_session_id = uuid4().hex
                sub_name = agent_prompt[:50] if agent_prompt else "Sub-agent"
                sub_session = AgentSession(
                    id=sub_session_id,
                    name=sub_name,
                    status="completed",
                    model=sub_model,
                    mode="sub-agent",
                    cwd=session.cwd,
                    created_at=datetime.now(),
                    cost_usd=sub_cost,
                    tokens=sub_tokens,
                    messages=[
                        Message(role="user", content=agent_prompt, branch_id="main"),
                        Message(role="assistant", content=sub_text, branch_id="main"),
                    ],
                    dashboard_id=session.dashboard_id,
                    parent_session_id=session_id,
                )
                self.sessions[sub_session_id] = sub_session
                await ws_manager.broadcast_global("agent:status", {
                    "session_id": sub_session_id,
                    "status": sub_session.status,
                    "session": sub_session.model_dump(mode="json"),
                })
                result_payload["sub_session_id"] = sub_session_id

            result_msg = Message(role="tool_result", content=result_payload, branch_id=session.active_branch_id)
            session.messages.append(result_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": result_msg.model_dump(mode="json"),
            })
            return {"continue_": True}

        try:
            _, mode_sys_prompt, _ = self._resolve_mode(session.mode)
            connected_tools_ctx = self._build_connected_tools_context(session.allowed_tools)
            outputs_ctx = self._build_outputs_context()
            browser_ctx = self._build_browser_context(session.dashboard_id, selected_browser_ids=selected_browser_ids)
            global_settings = load_settings()
            composed_prompt = self._compose_system_prompt(global_settings.default_system_prompt, mode_sys_prompt, session.system_prompt, connected_tools_ctx, outputs_ctx, browser_ctx)

            if session.mode == "view-builder":
                from backend.apps.outputs.view_builder_templates import VIEW_BUILDER_SKILL
                skill_block = f"<app_builder_reference>\n{VIEW_BUILDER_SKILL}\n</app_builder_reference>"
                composed_prompt = f"{composed_prompt}\n\n{skill_block}" if composed_prompt else skill_block

            mcp_servers = await self._build_mcp_servers(session.allowed_tools)

            _browser_delegation_tools = ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
            _browser_all_denied = all(
                _builtin_perms.get(t, "always_allow") == "deny"
                for t in _browser_delegation_tools
            )

            if not _browser_all_denied:
                browser_agent_server_path = os.path.join(
                    os.path.dirname(__file__), "browser_agent_mcp_server.py"
                )
                backend_port = os.environ.get("OPENSWARM_PORT", "8324")
                pre_selected_bids = self._get_pre_selected_browser_ids(session.dashboard_id)
                mcp_servers["openswarm-browser-agent"] = {
                    "command": sys.executable,
                    "args": [browser_agent_server_path],
                    "env": {
                        "OPENSWARM_PORT": backend_port,
                        "OPENSWARM_AGENT_MODEL": session.model,
                        "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                        "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
                        "OPENSWARM_PARENT_SESSION_ID": session.id,
                    },
                    "type": "stdio",
                }

            _invoke_agent_tools = ["InvokeAgent"]
            _invoke_all_denied = all(
                _builtin_perms.get(t, "always_allow") == "deny"
                for t in _invoke_agent_tools
            )

            if not _invoke_all_denied:
                invoke_agent_server_path = os.path.join(
                    os.path.dirname(__file__), "invoke_agent_mcp_server.py"
                )
                backend_port = os.environ.get("OPENSWARM_PORT", "8324")
                mcp_servers["openswarm-invoke-agent"] = {
                    "command": sys.executable,
                    "args": [invoke_agent_server_path],
                    "env": {
                        "OPENSWARM_PORT": backend_port,
                        "OPENSWARM_PARENT_SESSION_ID": session.id,
                        "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                    },
                    "type": "stdio",
                }

            effective_allowed = [
                t for t in session.allowed_tools
                if t in FULL_TOOLS and _builtin_perms.get(t, "always_allow") == "always_allow"
            ]

            effective_disallowed = [
                t for t in FULL_TOOLS
                if _builtin_perms.get(t, "always_allow") == "deny"
            ]

            if mcp_servers:
                all_tools_list = load_all_tools()
                for name in mcp_servers:
                    if name == "openswarm-browser-agent":
                        for bt in _browser_delegation_tools:
                            policy = _builtin_perms.get(bt, "always_allow")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__openswarm-browser-agent__{bt}")
                            elif policy == "deny":
                                effective_disallowed.append(f"mcp__openswarm-browser-agent__{bt}")
                        continue

                    if name == "openswarm-invoke-agent":
                        for it in _invoke_agent_tools:
                            policy = _builtin_perms.get(it, "always_allow")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__openswarm-invoke-agent__{it}")
                            elif policy == "deny":
                                effective_disallowed.append(f"mcp__openswarm-invoke-agent__{it}")
                        continue

                    tool_def = next(
                        (t for t in all_tools_list
                         if t.mcp_config and t.enabled and _sanitize_server_name(t.name) == name),
                        None,
                    )
                    if tool_def:
                        denied = _get_denied_tool_names(tool_def)
                        known = _get_all_known_tool_names(tool_def)
                        for tn in known - denied:
                            policy = tool_def.tool_permissions.get(tn, "ask")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__{name}__{tn}")
                        for tn in denied:
                            effective_disallowed.append(f"mcp__{name}__{tn}")
                    else:
                        effective_allowed.append(f"mcp__{name}__*")

            options_kwargs = {
                "model": session.model,
                "max_buffer_size": 5 * 1024 * 1024,
                "permission_mode": "default",
                "can_use_tool": can_use_tool,
                "hooks": {
                    "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
                    "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
                },
                "allowed_tools": effective_allowed,
                "disallowed_tools": effective_disallowed,
                "include_partial_messages": True,
            }
            if global_settings.anthropic_api_key:
                # Pass a minimal env allowlist — avoid leaking SSH keys, AWS
                # credentials, DB passwords, etc. stored in the shell environment.
                _ENV_ALLOWLIST = {
                    "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG",
                    "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
                    "XDG_RUNTIME_DIR", "TERM", "COLORTERM",
                    # Let through any existing ANTHROPIC_ vars (model overrides etc.)
                    *(k for k in os.environ if k.startswith("ANTHROPIC_")),
                }
                safe_env = {k: v for k, v in os.environ.items() if k in _ENV_ALLOWLIST}
                safe_env["ANTHROPIC_API_KEY"] = global_settings.anthropic_api_key
                options_kwargs["env"] = safe_env
            if mcp_servers:
                options_kwargs["mcp_servers"] = mcp_servers
            if composed_prompt:
                options_kwargs["system_prompt"] = composed_prompt
            if session.max_turns:
                options_kwargs["max_turns"] = session.max_turns

            if session.cwd:
                options_kwargs["cwd"] = session.cwd

            if session.sdk_session_id:
                options_kwargs["resume"] = session.sdk_session_id
                if fork_session:
                    options_kwargs["fork_session"] = True

            options = ClaudeAgentOptions(**options_kwargs)

            async def prompt_stream():
                yield {
                    "type": "user",
                    "message": {"role": "user", "content": prompt_content},
                }

            stream_text_msg_id = None
            stream_tool_msg_ids_ordered = []
            stream_block_index_map = {}

            async for message in query(
                prompt=prompt_stream(),
                options=options,
            ):
                if isinstance(message, StreamEvent):
                    event = message.event
                    event_type = event.get("type")

                    if event_type == "content_block_start":
                        block = event.get("content_block", {})
                        index = event.get("index")
                        block_type = block.get("type")

                        if block_type == "text":
                            if stream_text_msg_id is None:
                                stream_text_msg_id = uuid4().hex
                                await ws_manager.send_to_session(session_id, "agent:stream_start", {
                                    "session_id": session_id,
                                    "message_id": stream_text_msg_id,
                                    "role": "assistant",
                                })
                            stream_block_index_map[index] = stream_text_msg_id

                        elif block_type == "tool_use":
                            tool_msg_id = uuid4().hex
                            stream_tool_msg_ids_ordered.append(tool_msg_id)
                            stream_block_index_map[index] = tool_msg_id
                            await ws_manager.send_to_session(session_id, "agent:stream_start", {
                                "session_id": session_id,
                                "message_id": tool_msg_id,
                                "role": "tool_call",
                                "tool_name": block.get("name", ""),
                            })

                    elif event_type == "content_block_delta":
                        index = event.get("index")
                        delta = event.get("delta", {})
                        delta_type = delta.get("type")
                        msg_id = stream_block_index_map.get(index)

                        if msg_id and delta_type == "text_delta":
                            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                                "session_id": session_id,
                                "message_id": msg_id,
                                "delta": delta.get("text", ""),
                            })
                        elif msg_id and delta_type == "input_json_delta":
                            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                                "session_id": session_id,
                                "message_id": msg_id,
                                "delta": delta.get("partial_json", ""),
                            })

                    elif event_type == "content_block_stop":
                        index = event.get("index")
                        msg_id = stream_block_index_map.get(index)
                        if msg_id and msg_id != stream_text_msg_id:
                            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                                "session_id": session_id,
                                "message_id": msg_id,
                            })

                    elif event_type == "message_stop":
                        if stream_text_msg_id:
                            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                                "session_id": session_id,
                                "message_id": stream_text_msg_id,
                            })

                elif isinstance(message, AssistantMessage):
                    content_parts = []
                    tool_uses = []
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            content_parts.append(block.text)
                        elif isinstance(block, ToolUseBlock):
                            tool_uses.append({
                                "id": block.id,
                                "tool": block.name,
                                "input": block.input,
                            })

                    if content_parts:
                        asst_msg = Message(
                            id=stream_text_msg_id or uuid4().hex,
                            role="assistant",
                            content="\n".join(content_parts),
                            branch_id=session.active_branch_id,
                        )
                        session.messages.append(asst_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id,
                            "message": asst_msg.model_dump(mode="json"),
                        })

                    for i, tu in enumerate(tool_uses):
                        msg_id = stream_tool_msg_ids_ordered[i] if i < len(stream_tool_msg_ids_ordered) else uuid4().hex
                        tool_msg = Message(id=msg_id, role="tool_call", content=tu, branch_id=session.active_branch_id)
                        session.messages.append(tool_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id,
                            "message": tool_msg.model_dump(mode="json"),
                        })

                    stream_text_msg_id = None
                    stream_tool_msg_ids_ordered = []
                    stream_block_index_map = {}

                elif isinstance(message, ResultMessage):
                    session.sdk_session_id = getattr(message, "session_id", None)
                    cost = getattr(message, "total_cost_usd", None)
                    if cost is not None:
                        session.cost_usd = cost
                        await ws_manager.send_to_session(session_id, "agent:cost_update", {
                            "session_id": session_id,
                            "cost_usd": session.cost_usd,
                        })

            session.status = "completed"
        except asyncio.CancelledError:
            session.status = "stopped"
        except Exception as e:
            logger.exception(f"Agent {session_id} error: {e}")
            session.status = "error"
            error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
            session.messages.append(error_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": error_msg.model_dump(mode="json"),
            })
        finally:
            if session_id in self.sessions:
                await ws_manager.send_to_session(session_id, "agent:status", {
                    "session_id": session_id,
                    "status": session.status,
                    "session": session.model_dump(mode="json"),
                })
                try:
                    doc = session.model_dump(mode="json")
                    await asyncio.to_thread(_save_session, session_id, doc)
                except Exception as e:
                    logger.warning(f"Failed to snapshot session {session_id}: {e}")

    async def _stream_text(self, session_id: str, msg_id: str, text: str, delay: float = 0.03):
        """Emit stream_start, word-by-word deltas, and stream_end for a text message."""
        await ws_manager.send_to_session(session_id, "agent:stream_start", {
            "session_id": session_id,
            "message_id": msg_id,
            "role": "assistant",
        })
        words = text.split(" ")
        for i, word in enumerate(words):
            chunk = word if i == 0 else " " + word
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": msg_id,
                "delta": chunk,
            })
            await asyncio.sleep(delay)
        await ws_manager.send_to_session(session_id, "agent:stream_end", {
            "session_id": session_id,
            "message_id": msg_id,
        })

    async def _stream_tool_input(self, session_id: str, msg_id: str, tool_name: str, input_json: str, delay: float = 0.02):
        """Emit stream_start, chunked deltas, and stream_end for a tool_call input."""
        await ws_manager.send_to_session(session_id, "agent:stream_start", {
            "session_id": session_id,
            "message_id": msg_id,
            "role": "tool_call",
            "tool_name": tool_name,
        })
        chunk_size = 12
        for i in range(0, len(input_json), chunk_size):
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": msg_id,
                "delta": input_json[i:i + chunk_size],
            })
            await asyncio.sleep(delay)
        await ws_manager.send_to_session(session_id, "agent:stream_end", {
            "session_id": session_id,
            "message_id": msg_id,
        })

    async def _run_mock_agent(self, session_id: str, prompt: str):
        """Mock agent loop for development without claude_agent_sdk installed."""
        session = self.sessions.get(session_id)
        if not session:
            return

        await asyncio.sleep(1)
        
        request_id = uuid4().hex
        approval_req = ApprovalRequest(
            id=request_id,
            session_id=session_id,
            tool_name="Bash",
            tool_input={"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"},
        )
        session.pending_approvals.append(approval_req)
        session.status = "waiting_approval"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "waiting_approval",
        })
        
        decision = await ws_manager.send_approval_request(
            session_id, request_id, "Bash",
            {"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"}
        )
        
        session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
        })

        import json as _json
        tool_input_content = {"tool": "Bash", "input": {"command": f"echo 'Processing: {prompt}'"}, "approved": decision.get("behavior") == "allow"}
        tool_msg_id = uuid4().hex
        await self._stream_tool_input(
            session_id, tool_msg_id, "Bash",
            _json.dumps(tool_input_content["input"], indent=2),
        )
        tool_msg = Message(id=tool_msg_id, role="tool_call", content=tool_input_content, branch_id=session.active_branch_id)
        session.messages.append(tool_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": tool_msg.model_dump(mode="json"),
        })
        
        await asyncio.sleep(1)
        
        if decision.get("behavior") == "allow":
            tool_result = Message(role="tool_result", content=f"Processing: {prompt}", branch_id=session.active_branch_id)
            session.messages.append(tool_result)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": tool_result.model_dump(mode="json"),
            })
        
        await asyncio.sleep(1)

        asst_text = (
            f"I've processed your request: \"{prompt}\"\n\n"
            "This is a mock response because `claude-agent-sdk` is not installed. "
            "Install it with `pip install claude-agent-sdk` to use real Claude Code instances.\n\n"
            f"The agent was configured with:\n- Model: {session.model}\n- Mode: {session.mode}"
        )
        asst_msg_id = uuid4().hex
        await self._stream_text(session_id, asst_msg_id, asst_text)

        asst_msg = Message(id=asst_msg_id, role="assistant", content=asst_text, branch_id=session.active_branch_id)
        session.messages.append(asst_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": asst_msg.model_dump(mode="json"),
        })
        
        session.status = "completed"
        session.cost_usd = 0.001
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:cost_update", {
            "session_id": session_id,
            "cost_usd": session.cost_usd,
        })

    async def send_message(
        self,
        session_id: str,
        prompt: str,
        mode: str | None = None,
        model: str | None = None,
        images: list | None = None,
        context_paths: list | None = None,
        forced_tools: list[str] | None = None,
        attached_skills: list | None = None,
        hidden: bool = False,
        selected_browser_ids: list[str] | None = None,
    ):
        """Send a follow-up message to an existing session."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return

        session_changed = False
        if model and model != session.model:
            session.model = model
            session_changed = True
        if mode and mode != session.mode:
            session.mode = mode
            mode_tools, _, _ = self._resolve_mode(mode)
            session.allowed_tools = mode_tools
            session_changed = True
        if session_changed:
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": session.status,
                "session": session.model_dump(mode="json"),
            })

        skill_meta = [{"id": s["id"], "name": s["name"]} for s in (attached_skills or [])] or None
        image_meta = [{"data": img["data"], "media_type": img.get("media_type", "image/png")} for img in (images or [])] or None
        user_msg = Message(
            role="user",
            content=prompt,
            branch_id=session.active_branch_id,
            context_paths=context_paths if context_paths else None,
            attached_skills=skill_meta,
            forced_tools=forced_tools if forced_tools else None,
            images=image_meta,
            hidden=hidden,
        )
        session.messages.append(user_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": user_msg.model_dump(mode="json"),
        })

        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })

        self._ensure_session_loop(session_id)
        queue = self.message_queues.get(session_id)
        if queue is not None:
            await queue.put({
                "prompt": prompt,
                "images": images,
                "context_paths": context_paths,
                "forced_tools": forced_tools,
                "attached_skills": attached_skills,
                "selected_browser_ids": selected_browser_ids,
            })

    async def stop_agent(self, session_id: str):
        """Stop the running query for a session (but keep the loop alive)."""
        # Cancel only the in-flight query task, not the session loop.
        run_task = self.run_tasks.get(session_id)
        if run_task and not run_task.done():
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

        session = self.sessions.get(session_id)
        if session:
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
            session.pending_approvals = []

            session.status = "stopped"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
                "session": session.model_dump(mode="json"),
            })

        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

    def handle_approval(self, request_id: str, decision: dict):
        """Resolve a pending HITL approval."""
        ws_manager.resolve_approval(request_id, decision)

    async def edit_message(self, session_id: str, message_id: str, new_content: str):
        """Edit a prior user message, creating a new branch (fork)."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        # Cancel only the in-flight query (not the session loop).
        run_task = self.run_tasks.get(session_id)
        if run_task and not run_task.done():
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass

        target_msg = None
        for i, msg in enumerate(session.messages):
            if msg.id == message_id:
                target_msg = msg
                break

        if not target_msg or target_msg.role != "user":
            raise ValueError("Can only edit user messages")

        fork_point_id = message_id
        fork_parent_branch = target_msg.branch_id

        msg_branch = session.branches.get(target_msg.branch_id)
        if msg_branch and msg_branch.fork_point_message_id:
            branch_user_msgs = [
                m for m in session.messages
                if m.branch_id == target_msg.branch_id and m.role == "user"
            ]
            if branch_user_msgs and branch_user_msgs[0].id == message_id:
                fork_point_id = msg_branch.fork_point_message_id
                fork_parent_branch = msg_branch.parent_branch_id or "main"

        new_branch_id = uuid4().hex
        new_branch = MessageBranch(
            id=new_branch_id,
            parent_branch_id=fork_parent_branch,
            fork_point_message_id=fork_point_id,
        )
        session.branches[new_branch_id] = new_branch
        session.active_branch_id = new_branch_id

        edited_msg = Message(
            role="user",
            content=new_content,
            branch_id=new_branch_id,
            parent_id=target_msg.parent_id,
            images=target_msg.images,
            context_paths=target_msg.context_paths,
            forced_tools=target_msg.forced_tools,
            attached_skills=target_msg.attached_skills,
        )
        session.messages.append(edited_msg)

        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": edited_msg.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:branch_created", {
            "session_id": session_id,
            "branch": new_branch.model_dump(mode="json"),
            "active_branch_id": new_branch_id,
        })

        session.sdk_session_id = None
        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })

        # Drain the queue (stale messages from before the edit), restart the loop,
        # then enqueue the edited message.
        old_queue = self.message_queues.pop(session_id, None)
        if old_queue is not None:
            while not old_queue.empty():
                old_queue.get_nowait()
        loop_task = self.tasks.get(session_id)
        if loop_task and not loop_task.done():
            loop_task.cancel()
            try:
                await loop_task
            except asyncio.CancelledError:
                pass
        self._ensure_session_loop(session_id)
        queue = self.message_queues.get(session_id)
        if queue is not None:
            await queue.put({
                "prompt": new_content,
                "images": target_msg.images,
                "context_paths": target_msg.context_paths,
                "forced_tools": target_msg.forced_tools,
                "attached_skills": target_msg.attached_skills,
            })

    async def switch_branch(self, session_id: str, branch_id: str):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if branch_id not in session.branches:
            raise ValueError(f"Branch {branch_id} not found")
        session.active_branch_id = branch_id
        await ws_manager.send_to_session(session_id, "agent:branch_switched", {
            "session_id": session_id,
            "active_branch_id": branch_id,
        })

    async def generate_title(self, session_id: str, first_prompt: str) -> str:
        """Use a cheap LLM call to generate a short chat title from the first user message."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        title = first_prompt[:40].strip()
        try:
            import anthropic
            global_settings = load_settings()
            api_key = global_settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("API key not configured")
            client = anthropic.AsyncAnthropic(api_key=api_key)
            resp = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=30,
                system="Generate a concise 3-6 word title for a chat that starts with this message. Return only the title, nothing else.",
                messages=[{"role": "user", "content": first_prompt}],
            )
            generated = resp.content[0].text.strip().strip('"\'')
            if generated:
                title = generated
        except Exception as e:
            logger.warning(f"Title generation failed, using fallback: {e}")

        session.name = title
        await ws_manager.send_to_session(session_id, "agent:name_updated", {
            "session_id": session_id,
            "name": title,
        })
        return title

    async def generate_group_meta(
        self,
        session_id: str,
        group_id: str,
        tool_calls: list[dict],
        results_summary: list[str] | None = None,
        is_refinement: bool = False,
    ) -> dict:
        """Use a cheap LLM call to generate a name + SVG icon for a tool group."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        fallback_name = tool_calls[0].get("tool", "Tool calls") if tool_calls else "Tool calls"
        fallback_name = fallback_name.split("__")[-1].replace("_", " ").title() if "__" in fallback_name else fallback_name

        name = fallback_name
        svg = ""

        try:
            import anthropic, json as _json
            global_settings = load_settings()
            api_key = global_settings.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("API key not configured")
            client = anthropic.AsyncAnthropic(api_key=api_key)

            tool_desc = "\n".join(
                f"- {tc.get('tool', '?')}: {tc.get('input_summary', '')}" for tc in tool_calls
            )
            user_content = f"Tool actions:\n{tool_desc}"
            if results_summary:
                user_content += f"\n\nResults:\n" + "\n".join(f"- {r}" for r in results_summary)

            system = (
                "Generate a concise 2-5 word name and a minimal SVG icon for a group of tool actions.\n\n"
                "Return ONLY valid JSON: {\"name\": \"...\", \"svg\": \"...\"}\n\n"
                "Name rules:\n"
                "- 2-5 words, title case, describes the action (e.g. \"Email Inbox Search\", \"Reading Project Files\")\n\n"
                "SVG rules:\n"
                "- 24x24 viewBox\n"
                "- Use currentColor for all stroke/fill values\n"
                "- Simple geometric shapes only (line, circle, rect, path, polyline)\n"
                "- No text elements, no embedded images, no gradients, no filters\n"
                "- Minimal: 1-3 shapes, stroke-width=\"1.5\", fill=\"none\" unless intentional\n"
                "- Return ONLY the inner SVG elements (no outer <svg> tag)\n"
                "- Max 400 characters for the svg string"
            )

            resp = await client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=300,
                system=system,
                messages=[{"role": "user", "content": user_content}],
            )

            raw = resp.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            parsed = _json.loads(raw)
            if parsed.get("name"):
                name = parsed["name"].strip().strip("\"'")
            if parsed.get("svg"):
                svg = parsed["svg"].strip()
        except Exception as e:
            logger.warning(f"Group meta generation failed, using fallback: {e}")

        meta = ToolGroupMeta(id=group_id, name=name, svg=svg, is_refined=is_refinement)
        session.tool_group_meta[group_id] = meta

        await ws_manager.send_to_session(session_id, "agent:group_meta_updated", {
            "session_id": session_id,
            "group_id": group_id,
            "name": name,
            "svg": svg,
            "is_refined": is_refinement,
        })

        return {"name": name, "svg": svg, "is_refined": is_refinement}

    async def update_session(self, session_id: str, **fields):
        """Update mutable session fields (system_prompt, name)."""
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        allowed = {"system_prompt", "name"}
        for key, value in fields.items():
            if key in allowed:
                setattr(session, key, value)

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })

    @staticmethod
    def _build_search_text(session: AgentSession, max_len: int = 5000) -> str:
        """Build a search-indexing string from the session name and message content."""
        parts = [session.name or ""]
        for msg in session.messages:
            if msg.role in ("user", "assistant") and isinstance(msg.content, str):
                parts.append(msg.content)
        text = " ".join(parts)
        return text[:max_len]

    async def _kill_session_tasks(self, session_id: str) -> None:
        """Cancel both the in-flight query and the session loop, then clean up."""
        # 1. Cancel the current query.
        run_task = self.run_tasks.pop(session_id, None)
        if run_task and not run_task.done():
            run_task.cancel()
            try:
                await run_task
            except asyncio.CancelledError:
                pass
        # 2. Send the stop sentinel so the loop exits cleanly, then cancel.
        queue = self.message_queues.get(session_id)
        if queue is not None:
            await queue.put(_QUEUE_STOP)
        loop_task = self.tasks.get(session_id)
        if loop_task and not loop_task.done():
            loop_task.cancel()
            try:
                await loop_task
            except asyncio.CancelledError:
                pass
        self.tasks.pop(session_id, None)
        self.message_queues.pop(session_id, None)

    async def close_session(self, session_id: str) -> None:
        """Close a session: pause the agent if running, persist to JSON file,
        and remove from in-memory state. Also stops browser-agent children."""
        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

        await self._kill_session_tasks(session_id)

        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        if session.status in ("running", "waiting_approval"):
            session.status = "stopped"
        session.closed_at = datetime.now()

        for req in list(session.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Session closed"})
        session.pending_approvals = []

        doc_data = session.model_dump(mode="json")
        doc_data["search_text"] = self._build_search_text(session)

        _save_session(session_id, doc_data)

        await ws_manager.send_to_session(session_id, "agent:closed", {
            "session_id": session_id,
            "status": session.status,
            "name": session.name,
            "model": session.model,
            "mode": session.mode,
            "created_at": session.created_at.isoformat() if session.created_at else None,
            "closed_at": session.closed_at.isoformat() if session.closed_at else None,
            "cost_usd": session.cost_usd,
            "dashboard_id": session.dashboard_id,
        })

        self.sessions.pop(session_id, None)
        self.tasks.pop(session_id, None)
        logger.info(f"Session {session_id} closed and persisted")

    async def delete_session(self, session_id: str) -> None:
        """Permanently delete a session: remove from memory and JSON file.
        Also stops browser-agent children first."""
        children = [
            s for s in self.sessions.values()
            if s.parent_session_id == session_id and s.mode == "browser-agent"
        ]
        for child in children:
            await self.stop_agent(child.id)

        await self._kill_session_tasks(session_id)

        self.sessions.pop(session_id, None)

        _delete_session_file(session_id)
        logger.info(f"Session {session_id} permanently deleted")

    async def resume_session(self, session_id: str) -> AgentSession:
        """Restore a closed session from JSON file back into active memory."""
        if session_id in self.sessions:
            return self.sessions[session_id]

        data = _load_session_data(session_id)
        if data is None:
            raise ValueError(f"Session {session_id} not found in history")

        session = AgentSession(**data)

        session.closed_at = None
        self.sessions[session_id] = session

        _delete_session_file(session_id)

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })

        logger.info(f"Session {session_id} resumed from history")
        return session

    def get_history(
        self,
        q: str = "",
        limit: int = 20,
        offset: int = 0,
        dashboard_id: str | None = None,
    ) -> dict:
        """Return paginated, optionally filtered summaries of closed sessions."""
        all_data = _load_all_session_data()
        all_data.sort(key=lambda pair: pair[1].get("closed_at") or "", reverse=True)

        q_lower = q.strip().lower()
        history = []
        for sid, data in all_data:
            if dashboard_id and data.get("dashboard_id") != dashboard_id:
                continue
            if q_lower:
                name = (data.get("name") or "").lower()
                search_text = (data.get("search_text") or "").lower()
                if q_lower not in name and q_lower not in search_text:
                    continue
            history.append({
                "id": data.get("id", sid),
                "name": data.get("name", "Untitled"),
                "status": data.get("status", "stopped"),
                "model": data.get("model", "sonnet"),
                "mode": data.get("mode", "agent"),
                "created_at": data.get("created_at"),
                "closed_at": data.get("closed_at"),
                "cost_usd": data.get("cost_usd", 0),
                "dashboard_id": data.get("dashboard_id"),
            })

        total = len(history)
        page = history[offset : offset + limit]
        return {
            "sessions": page,
            "total": total,
            "has_more": offset + limit < total,
        }

    async def reconcile_on_startup(self) -> None:
        """Mark any stale running sessions as stopped."""
        for sid, data in _load_all_session_data():
            if data.get("status") in ("running", "waiting_approval"):
                data["status"] = "stopped"
                _save_session(sid, data)
                logger.info(f"Marked stale session {sid} as stopped")

    async def persist_all_sessions(self) -> None:
        """Flush every in-memory session to JSON files (for graceful shutdown)."""
        for session_id, session in list(self.sessions.items()):
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Server shutting down"})
            session.pending_approvals = []
            doc_data = session.model_dump(mode="json")
            doc_data["search_text"] = self._build_search_text(session)
            _save_session(session_id, doc_data)
            logger.info(f"Persisted session {session_id} on shutdown")
        self.sessions.clear()
        self.tasks.clear()

    async def restore_all_sessions(self) -> None:
        """On startup, reload all persisted sessions from JSON files back into memory.

        Only sessions without closed_at are restored (they were active at
        shutdown).  Sessions with closed_at were explicitly closed by the user
        and stay on disk so the history endpoint can still serve them.
        """
        for sid, data in _load_all_session_data():
            try:
                session = AgentSession(**data)
            except Exception as e:
                logger.warning(f"Skipping corrupt session file {sid}: {e}")
                continue
            if session.closed_at is not None:
                continue
            if session.status in ("running", "waiting_approval"):
                session.status = "stopped"
            session.pending_approvals = []
            self.sessions[session.id] = session
            _delete_session_file(sid)
            logger.info(f"Restored session {session.id}")

    async def duplicate_session(self, session_id: str, dashboard_id: str | None = None, up_to_message_id: str | None = None) -> AgentSession:
        """Create an independent copy of a session with the same chat history."""
        source = self.sessions.get(session_id)
        if not source:
            data = _load_session_data(session_id)
            if data is None:
                raise ValueError(f"Session {session_id} not found")
            source = AgentSession(**data)

        source_messages = list(source.messages)
        if up_to_message_id:
            cut_idx = next(
                (i for i, m in enumerate(source_messages) if m.id == up_to_message_id),
                None,
            )
            if cut_idx is not None:
                source_messages = source_messages[: cut_idx + 1]

        old_to_new_msg: dict[str, str] = {}
        new_messages: list[Message] = []
        for msg in source_messages:
            new_id = uuid4().hex
            old_to_new_msg[msg.id] = new_id
            new_messages.append(Message(
                id=new_id,
                role=msg.role,
                content=msg.content,
                timestamp=msg.timestamp,
                branch_id=msg.branch_id,
                parent_id=old_to_new_msg.get(msg.parent_id) if msg.parent_id else None,
                context_paths=msg.context_paths,
                attached_skills=msg.attached_skills,
                forced_tools=msg.forced_tools,
                images=msg.images,
            ))

        new_branches: dict[str, MessageBranch] = {}
        for bid, branch in source.branches.items():
            new_branches[bid] = MessageBranch(
                id=bid,
                parent_branch_id=branch.parent_branch_id,
                fork_point_message_id=old_to_new_msg.get(branch.fork_point_message_id) if branch.fork_point_message_id else None,
                created_at=branch.created_at,
            )

        new_session = AgentSession(
            id=uuid4().hex,
            name=f"{source.name} (copy)",
            status="stopped",
            model=source.model,
            mode=source.mode,
            system_prompt=source.system_prompt,
            allowed_tools=list(source.allowed_tools),
            max_turns=source.max_turns,
            cwd=source.cwd,
            created_at=datetime.now(),
            messages=new_messages,
            branches=new_branches,
            active_branch_id=source.active_branch_id,
            tool_group_meta=dict(source.tool_group_meta),
            dashboard_id=dashboard_id or source.dashboard_id,
        )

        self.sessions[new_session.id] = new_session

        await ws_manager.send_to_session(new_session.id, "agent:status", {
            "session_id": new_session.id,
            "status": new_session.status,
            "session": new_session.model_dump(mode="json"),
        })

        return new_session

    async def invoke_agent(
        self,
        source_session_id: str,
        message: str,
        parent_session_id: str | None = None,
        dashboard_id: str | None = None,
    ) -> dict:
        """Fork an existing session and send it a new message, returning the result."""
        source = self.sessions.get(source_session_id)
        if not source:
            data = _load_session_data(source_session_id)
            if data is None:
                raise ValueError(f"Session {source_session_id} not found")
            source = AgentSession(**data)

        source_name = source.name

        old_to_new_msg: dict[str, str] = {}
        new_messages: list[Message] = []
        for msg in source.messages:
            new_id = uuid4().hex
            old_to_new_msg[msg.id] = new_id
            new_messages.append(Message(
                id=new_id,
                role=msg.role,
                content=msg.content,
                timestamp=msg.timestamp,
                branch_id=msg.branch_id,
                parent_id=old_to_new_msg.get(msg.parent_id) if msg.parent_id else None,
                context_paths=msg.context_paths,
                attached_skills=msg.attached_skills,
                forced_tools=msg.forced_tools,
                images=msg.images,
            ))

        new_branches: dict[str, MessageBranch] = {}
        for bid, branch in source.branches.items():
            new_branches[bid] = MessageBranch(
                id=bid,
                parent_branch_id=branch.parent_branch_id,
                fork_point_message_id=(
                    old_to_new_msg.get(branch.fork_point_message_id)
                    if branch.fork_point_message_id else None
                ),
                created_at=branch.created_at,
            )

        fork = AgentSession(
            id=uuid4().hex,
            name=f"{source_name} (invoked)",
            status="running",
            model=source.model,
            mode="invoked-agent",
            sdk_session_id=source.sdk_session_id,
            system_prompt=source.system_prompt,
            allowed_tools=list(source.allowed_tools),
            max_turns=source.max_turns or 25,
            cwd=source.cwd,
            created_at=datetime.now(),
            messages=new_messages,
            branches=new_branches,
            active_branch_id=source.active_branch_id,
            tool_group_meta=dict(source.tool_group_meta),
            dashboard_id=dashboard_id or source.dashboard_id,
            parent_session_id=parent_session_id,
        )

        self.sessions[fork.id] = fork

        await ws_manager.broadcast_global("agent:status", {
            "session_id": fork.id,
            "status": fork.status,
            "session": fork.model_dump(mode="json"),
        })

        user_msg = Message(
            role="user",
            content=message,
            branch_id=fork.active_branch_id,
        )
        fork.messages.append(user_msg)
        await ws_manager.send_to_session(fork.id, "agent:message", {
            "session_id": fork.id,
            "message": user_msg.model_dump(mode="json"),
        })

        await self._run_agent_loop(fork.id, message, fork_session=True)

        last_assistant = None
        for msg in reversed(fork.messages):
            if msg.role == "assistant":
                content = msg.content
                if isinstance(content, str):
                    last_assistant = content
                elif isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    last_assistant = "\n".join(texts)
                else:
                    last_assistant = str(content)
                break

        return {
            "forked_session_id": fork.id,
            "source_name": source_name,
            "response": last_assistant or "No response from invoked agent.",
            "cost_usd": fork.cost_usd,
        }

    def get_all_sessions(self, dashboard_id: str | None = None) -> list[AgentSession]:
        if dashboard_id:
            return [s for s in self.sessions.values() if s.dashboard_id == dashboard_id]
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Optional[AgentSession]:
        return self.sessions.get(session_id)

    def get_browser_agent_children(self, parent_session_id: str) -> list[dict]:
        """Return browser-agent sessions for a parent, from memory or disk."""
        results: list[dict] = []
        seen: set[str] = set()

        for s in self.sessions.values():
            if s.mode == "browser-agent" and s.parent_session_id == parent_session_id:
                results.append(s.model_dump(mode="json"))
                seen.add(s.id)

        for sid, data in _load_all_session_data():
            if sid in seen:
                continue
            if data.get("mode") == "browser-agent" and data.get("parent_session_id") == parent_session_id:
                results.append(data)

        return results

agent_manager = AgentManager()
