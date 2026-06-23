import asyncio
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from uuid import uuid4
from typing import Dict, Optional

from backend.apps.agents.core.models import (
    AgentConfig, AgentSession, Message, MessageBranch, ApprovalRequest, ToolGroupMeta,
)
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    _save as save_tool,
    _sanitize_server_name,
    derive_mcp_config,
    load_builtin_permissions,
    load_trusted_sensitive_paths,
    refresh_airtable_token,
    refresh_google_token,
    refresh_hubspot_token,
    resolve_policy_slot,
    save_builtin_permissions,
    save_trusted_sensitive_paths,
)
from backend.config.paths import SESSIONS_DIR
from backend.apps.agents.core.error_classify import (
    _NON_TRANSIENT_PATTERNS,
    _TRANSIENT_CAPACITY_PATTERNS,
    CAPACITY_BACKOFFS,
    capacity_retry_wait,
    _is_auth_error,
    _is_free_trial_exhausted,
    _is_long_context_error,
    _is_transient_capacity_error,
    _is_unknown_model_error,
    parse_retry_after,
    redact_for_telemetry,
)
from backend.apps.agents.manager.session.session_store import (
    _load_session_data,
    _save_session,
)
from backend.apps.agents.manager import metadata
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.permissions import path_gate
from backend.apps.agents.manager import context_budget
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.hook_context import HookContext
from backend.apps.agents.manager.streaming import thinking as thinking_mod
from backend.apps.agents.manager.streaming import tool_result_hook
from backend.apps.agents.manager.streaming import stop_hook as stop_hook_mod
from backend.apps.agents.manager.streaming import stream_event
from backend.apps.agents.manager.streaming import assistant_message
from backend.apps.agents.manager.streaming.upsert_message import upsert_message
from backend.apps.agents.manager.prompt.system_prompt import compose_turn_system_prompt
from backend.apps.agents.tools.web import should_register_web_mcp
from backend.apps.agents.manager.session.SessionLifecycleMixin import SessionLifecycleMixin
from backend.apps.agents.manager.MessagingMixin import MessagingMixin
from backend.apps.agents.manager.permissions import gate_hooks
from backend.apps.agents.manager.session.workspace_git import _detect_git_identity, _ensure_cwd_git_repo
from backend.apps.agents.manager.prompt.tool_catalog import (
    FULL_TOOLS,
    get_all_known_tool_names,
    get_denied_tool_names,
    is_fully_denied,
    gated_mcp_server_names,
    get_all_tool_names,
)
from backend.apps.agents.core.aux_llm import _safe_resp_text, clean_short_label, aux_max_tokens_for
from backend.apps.agents.manager.session.history_compaction import (
    _build_history_prefix,
    _estimate_post_compact_input,
    _get_branch_messages,
)
from backend.apps.agents.manager.prompt.prompt_context import resolve_mode
from backend.apps.agents.manager.prompt.attachments import (
    _build_dir_tree,
    _build_prompt_content,
    _resolve_attachments,
    _resolve_context_paths,
)

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


class AgentManager(SessionLifecycleMixin, MessagingMixin):
    def __init__(self):
        self.sessions: dict[str, AgentSession] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        # Live mirror of the in-flight streamed assistant text per session, so a
        # stop can persist the partial reply instantly instead of waiting out the
        # multi-second SDK teardown the cancel handler sits behind.
        self._live_partial: dict[str, dict] = {}

    async def _build_mcp_servers(
        self,
        allowed_tools: list[str],
        active_mcps: list[str] | None = None,
    ) -> dict:
        """Build the mcp_servers dict for ClaudeAgentOptions from installed MCP tools.

        Filtering is two-stage:
          1. allowed_tools (mode/session permission), same as before.
          2. active_mcps (per-session activation gate), NEW. When this list is
             provided (non-None), only MCP servers whose sanitized name appears
             in it are forwarded to the SDK. Empty list means zero MCPs ship.
             None means legacy / non-gated path (used by sessions created
             before the gate existed, where active_mcps was implicit-all).

        The activation gate is the dispatch-layer enforcement of the product
        invariant "all MCP actions only via ToolSearch": the model can only
        reach an MCP server's tools if the user has approved MCPActivate for
        that server, which appends to session.active_mcps. The model cannot
        bypass this by ignoring prompt instructions, the SDK simply receives
        no MCP definition for unactivated servers.

        Servers whose every sub-tool is denied are skipped entirely.
        """
        mcp_servers: dict = {}
        all_tools = load_all_tools()
        mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]
        active_set = set(active_mcps) if active_mcps is not None else None
        logger.info(
            f"[MCP-DEBUG] Building MCP servers. {len(mcp_tools)} MCP tools found, "
            f"allowed_tools has {len(allowed_tools)} entries, "
            f"active_mcps={'<unset/all>' if active_set is None else sorted(active_set)}"
        )

        for tool in mcp_tools:
            tool_ref = f"mcp:{tool.name}"
            if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
                if not any(tool_ref == at for at in allowed_tools):
                    logger.info(f"[MCP-DEBUG] SKIPPED {tool.name}: '{tool_ref}' not in allowed_tools")
                    continue

            server_name = _sanitize_server_name(tool.name)
            if active_set is not None and server_name not in active_set:
                logger.info(f"[MCP-DEBUG] GATED {server_name}: not in session.active_mcps, model must call MCPActivate first")
                continue

            if is_fully_denied(tool):
                logger.info(f"[MCP-DEBUG] SKIPPED {tool.name}: fully denied")
                continue

            if tool.auth_type == "oauth2" and tool.auth_status == "connected":
                if tool.name.lower() in ("discord", "github"):
                    # Discord uses a shared bot token; GitHub OAuth-app tokens don't
                    # expire and carry no refresh_token. Nothing to refresh either way.
                    refreshed = True
                elif tool.name.lower() == "airtable":
                    refreshed = await refresh_airtable_token(tool)
                elif tool.name.lower() == "hubspot":
                    refreshed = await refresh_hubspot_token(tool)
                else:
                    refreshed = await refresh_google_token(tool)
                logger.info(f"[MCP-DEBUG] {tool.name} token refresh: {'OK' if refreshed else 'FAILED'}")

            config = derive_mcp_config(tool)
            if config:
                mcp_servers[server_name] = config
                env_keys = list(config.get("env", {}).keys())
                logger.info(f"[MCP-DEBUG] ADDED {server_name}: command={config.get('command')}, args={config.get('args')}, env_keys={env_keys}")
            else:
                logger.warning(f"[MCP-DEBUG] {tool.name}: derive_mcp_config returned None")

        logger.info(f"[MCP-DEBUG] Final mcp_servers: {list(mcp_servers.keys())}")
        return mcp_servers

    async def launch_agent(self, config: AgentConfig) -> AgentSession:
        session_id = uuid4().hex

        mode_tools, _, mode_folder = resolve_mode(config.mode, get_all_tool_names)
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

        # Canvas-chat App Builder launch: when the user picks "App Builder"
        # mode from the chat-input dropdown (no preexisting workspace, no
        # target_directory passed in), the legacy code path only created an
        # empty folder, so the agent could write files but the app never
        # showed up in the Apps sidebar (no Output row, which is what the
        # sidebar reads). Mirror the /workspace/seed endpoint's behavior
        # here: seed the React template + register an Output row with
        # workspace_id = session_id. Idempotent; safe if the session is
        # ever re-launched with the same id.
        if config.mode == "view-builder" and not config.target_directory:
            try:
                from backend.apps.outputs.outputs import (
                    ensure_webapp_workspace_seeded_and_registered,
                    _load,
                )
                output_id = ensure_webapp_workspace_seeded_and_registered(
                    workspace_id=session_id,
                    folder=effective_cwd,
                    session_id=session_id,
                )
                if output_id:
                    # Broadcast the new row so the Apps sidebar lights up
                    # immediately, even before the user clicks into it. The
                    # row name is still the placeholder ("Untitled App") at
                    # this point; the post-session meta-sync below fires a
                    # second upsert with the real name once the agent has
                    # written meta.json.
                    try:
                        new_output = _load(output_id)
                        await ws_manager.broadcast_global("agent:output_upserted", {
                            "output": new_output.model_dump(mode="json"),
                        })
                    except Exception:
                        logger.exception("post-seed output_upserted broadcast failed")
            except Exception:
                logger.exception(
                    "view-builder workspace seed/register failed; session will "
                    "still launch but the app may not appear in Apps sidebar"
                )

        # If the fallback chain landed on the user's home directory (no
        # project dir, no default_folder set), re-route to a dedicated
        # scratch workspace under ~/.openswarm/workspaces/<session_id>.
        # This prevents us from writing .git/ (or anything else) into
        # the user's $HOME and gives the CLI's Agent tool a clean repo
        # to do worktree isolation inside. Users with a default_folder
        # or target_directory set keep whatever they configured.
        _home = os.path.expanduser("~")
        if os.path.abspath(effective_cwd) == os.path.abspath(_home):
            effective_cwd = os.path.join(_home, ".openswarm", "workspaces", session_id)
            os.makedirs(effective_cwd, exist_ok=True)

        _ensure_cwd_git_repo(effective_cwd, _home)

        repo_url, branch_name = _detect_git_identity(effective_cwd)

        session = AgentSession(
            id=session_id,
            name=config.name,
            provider=getattr(config, "provider", "anthropic"),
            model=config.model,
            mode=config.mode,
            system_prompt=config.system_prompt,
            allowed_tools=tools,
            max_turns=config.max_turns,
            cwd=effective_cwd,
            repo_url=repo_url,
            branch=branch_name,
            dashboard_id=config.dashboard_id,
            thinking_level=getattr(global_settings, "default_thinking_level", "auto"),
        )
        apply_context_window(session, global_settings)
        self.sessions[session_id] = session

        from backend.apps.service.version import APP_VERSION

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "running",
            "session": session.model_dump(mode="json"),
        })

        return session

    def _build_dir_tree(self, root: str, max_depth: int = 4, prefix: str = "") -> list[str]:
        return _build_dir_tree(root, max_depth, prefix)

    # ------------------------------------------------------------------
    # Compaction & token guard (Phase 2)
    #
    # Triggered by *live* context-usage ratio, not turn count. The signal
    # is the same `ctx_used_pct` we already broadcast to the UI on every
    # turn: input_tokens / context_window. Three escalating thresholds:
    #   - compact_threshold_pct (default 0.65): summarize stale tool_results
    #     and old user/assistant pairs before the next query() call
    #   - context_soft_cap_pct (default 0.90): pre-send hard guard. After
    #     compaction, if still over, LRU-trim active_mcps
    #   - >= 1.0 hits the proxy/Anthropic 200K ceiling, friendly card
    #     surfaces from the catch-all
    # ------------------------------------------------------------------

    def _maybe_compact(self, session: AgentSession, force: bool = False) -> bool:
        return context_budget.maybe_compact(session, force)

    async def _emit_context_update(
        self,
        session_id: str,
        session: AgentSession,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        cache_read_tokens: int = 0,
        cache_read_pct: float = 0.0,
    ) -> None:
        return await context_budget.emit_context_update(
            session_id, session,
            input_tokens=input_tokens, output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens, cache_read_pct=cache_read_pct,
        )

    def _build_prompt_content(self, prompt: str, images: list | None = None, context_paths: list | None = None, forced_tools: list[str] | None = None, attached_skills: list | None = None, api_type: str = "anthropic", model: str = ""):
        return _build_prompt_content(prompt, images, context_paths, forced_tools, attached_skills, api_type, model)

    def _resolve_attachments(self, context_paths: list | None, api_type: str, model: str) -> tuple[str, list[dict], list[str]]:
        return _resolve_attachments(context_paths, api_type, model)

    def _resolve_context_paths(self, context_paths: list | None) -> str:
        return _resolve_context_paths(context_paths)

    async def _run_agent_loop(self, session_id: str, prompt: str, images: list | None = None, context_paths: list | None = None, forced_tools: list[str] | None = None, attached_skills: list | None = None, fork_session: bool = False, selected_browser_ids: list[str] | None = None, selected_app_output_ids: list[str] | None = None, selected_setting_ids: list[str] | None = None):
        """Run the Claude Agent SDK query loop for a session."""
        session = self.sessions.get(session_id)
        if not session:
            return
        
        from backend.apps.agents.providers.registry import get_api_type as _get_api_type
        _api = _get_api_type(session.model)
        prompt_content = self._build_prompt_content(
            prompt, images, context_paths, forced_tools, attached_skills,
            api_type=_api, model=session.model,
        )

        try:
            from claude_agent_sdk import (
                query, ClaudeAgentOptions, AssistantMessage, ResultMessage,
            )
            from claude_agent_sdk.types import (
                HookMatcher,
                TextBlock, ToolUseBlock, ThinkingBlock, StreamEvent,
                SystemMessage,
            )
        except ImportError:
            logger.warning("claude_agent_sdk not installed, running in mock mode")
            await self._run_mock_agent(session_id, prompt)
            return

        session.status = "running"

        # Resolve the model id now so every closure (approval hook, tool
        # executed handler, etc.) has both the short name and the
        # 9Router-prefixed id available without re-resolving. The short
        # name is what the user sees; the router id is what 9Router
        # reports its per-model counters under.
        from backend.apps.agents.providers.registry import (
            resolve_model_id_for_sdk as _resolve_model_id_early,
            get_api_type as _get_api_type_early,
        )
        _router_model_id = _resolve_model_id_early(session.model, load_settings())
        _api_type_for_session = _get_api_type_early(session.model)

        builtin_perms = load_builtin_permissions()

        # Per-tool DEFAULT policy (overridden by anything the user has set
        # explicitly in builtin_permissions.json). Bash defaults to
        # always_allow like every other builtin, for a frictionless run.
        # Three guards in path_gate STILL force a prompt even on always_allow:
        # the catastrophic-pattern match (rm -rf and friends), OS-scheduling
        # (cron/launchd persistence), and the sensitive-path gate. So the
        # poisoned-email -> destructive-command case is still caught; what
        # this trades away is the prompt on ordinary shell commands. Users
        # who want a prompt on every command can flip Bash to "ask" in the UI.
        hook_ctx = HookContext(
            session=session,
            session_id=session_id,
            prompt=prompt,
            builtin_perms=builtin_perms,
            policy_defaults={},
            sessions=self.sessions,
        )

        async def can_use_tool(tool_name, input_data, context):
            return await gate_hooks.can_use_tool(hook_ctx, tool_name, input_data, context)

        async def pre_tool_hook(input_data, tool_use_id, context):
            return await gate_hooks.pre_tool_hook(hook_ctx, input_data, tool_use_id, context)

        async def post_tool_hook(input_data, tool_use_id, context):
            return await tool_result_hook.post_tool_hook(hook_ctx, input_data, tool_use_id, context)

        try:
            _, mode_sys_prompt, _ = resolve_mode(session.mode, get_all_tool_names)

            # Reconcile active_mcps against currently-enabled tools (Phase 3).
            # If the user toggled a server off in the Tools page mid-session,
            # drop it from active_mcps automatically so the model isn't told
            # "X is active" while _build_mcp_servers silently filters it out.
            # Emit a context_status event so the model and UI both know.
            try:
                _enabled = {
                    _sanitize_server_name(t.name)
                    for t in load_all_tools()
                    if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")
                }
                _stale = [s for s in session.active_mcps if s not in _enabled]
                if _stale:
                    session.active_mcps = [s for s in session.active_mcps if s in _enabled]
                    session.needs_fork = True
                    await ws_manager.send_to_session(session_id, "agent:context_status", {
                        "session_id": session_id,
                        "reason": "mcp_disabled_externally",
                        "deactivated": _stale,
                    })
                    logger.info(f"Reconciled stale active_mcps for session {session_id}: dropped {_stale}")
            except Exception:
                logger.exception("active_mcps reconciliation failed; proceeding")

            global_settings = load_settings()
            composed_prompt = compose_turn_system_prompt(
                session,
                mode_sys_prompt,
                global_settings.default_system_prompt,
                selected_browser_ids,
                selected_app_output_ids,
                selected_setting_ids,
            )

            # Per-turn estimate of framework overhead (subtracted from displayed
            # input). Conservative on purpose so honest over-shows beat lies.
            # 16K Claude Code preset, 12K base+deferred tools, ~3K/MCP (real
            # MCP tool definitions range 1-10K depending on server; 3K is a
            # rough median that keeps the meter honest without over-trimming),
            # char/4 of composed prompt.
            _PRESET_OVERHEAD = 16_000
            _TOOL_DEFS_OVERHEAD = 12_000
            _PER_MCP_OVERHEAD = 3_000
            _composed_tokens = len(composed_prompt or "") // 4
            _mcp_tokens = len(session.active_mcps) * _PER_MCP_OVERHEAD
            session.framework_overhead_tokens = (
                _PRESET_OVERHEAD + _TOOL_DEFS_OVERHEAD + _composed_tokens + _mcp_tokens
            )

            # Pass session.active_mcps as the activation filter. Empty list ⇒
            # no MCP tools shipped to the SDK; the model must MCPSearch and
            # MCPActivate first. The product invariant lives here at the
            # dispatch layer (see _build_mcp_servers docstring).
            mcp_servers = await self._build_mcp_servers(session.allowed_tools, session.active_mcps)

            _browser_delegation_tools = ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
            _browser_all_denied = all(
                builtin_perms.get(t, "always_allow") == "deny"
                for t in _browser_delegation_tools
            )

            if not _browser_all_denied:
                browser_agent_server_path = os.path.join(
                    os.path.dirname(__file__), "browser_agent_mcp_server.py"
                )
                backend_port = os.environ.get("OPENSWARM_PORT", "8324")
                # Only the card the user actually picked in select-mode gets claimed for the
                # task, so the sub drives that one instead of opening its own duplicate. Passing
                # EVERY dashboard card here (the old behavior) made the sub force-grab a random,
                # usually-parked card and never navigate it, which broke the bulk of browser tasks.
                pre_selected_bids = [b for b in (selected_browser_ids or []) if b]
                from backend.auth import get_auth_token as _get_auth_token
                _auth_tok = _get_auth_token()
                mcp_servers["openswarm-browser-agent"] = {
                    "command": sys.executable,
                    "args": [browser_agent_server_path],
                    "env": {
                        "OPENSWARM_PORT": backend_port,
                        "OPENSWARM_AUTH_TOKEN": _auth_tok,
                        "OPENSWARM_AGENT_MODEL": session.model,
                        "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                        "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
                        "OPENSWARM_PARENT_SESSION_ID": session.id,
                    },
                    "type": "stdio",
                }

            _invoke_agent_tools = ["InvokeAgent"]
            _invoke_all_denied = all(
                builtin_perms.get(t, "always_allow") == "deny"
                for t in _invoke_agent_tools
            )

            if not _invoke_all_denied:
                invoke_agent_server_path = os.path.join(
                    os.path.dirname(__file__), "invoke_agent_mcp_server.py"
                )
                backend_port = os.environ.get("OPENSWARM_PORT", "8324")
                from backend.auth import get_auth_token as _get_auth_token2
                mcp_servers["openswarm-invoke-agent"] = {
                    "command": sys.executable,
                    "args": [invoke_agent_server_path],
                    "env": {
                        "OPENSWARM_PORT": backend_port,
                        "OPENSWARM_AUTH_TOKEN": _get_auth_token2(),
                        "OPENSWARM_PARENT_SESSION_ID": session.id,
                        "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                    },
                    "type": "stdio",
                }

            # Always-on meta-MCP server. Exposes MCPList / MCPSearch /
            # MCPActivate so the model can discover and activate user MCPs at
            # runtime. The activation gate (active_mcps filter in
            # _build_mcp_servers above) ensures the model cannot reach any
            # other MCP server's tools without going through this layer first.
            mcp_meta_server_path = os.path.join(
                os.path.dirname(__file__), "mcp_meta_server.py"
            )
            from backend.auth import get_auth_token as _get_auth_token3
            mcp_servers["openswarm-mcp-meta"] = {
                "command": sys.executable,
                "args": [mcp_meta_server_path],
                "env": {
                    "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
                    "OPENSWARM_AUTH_TOKEN": _get_auth_token3(),
                    "OPENSWARM_PARENT_SESSION_ID": session.id,
                },
                "type": "stdio",
            }

            # Always-on settings-meta server: SettingsRead / SettingsWrite let the
            # agent read and edit its own OpenSwarm Settings autonomously. The
            # backend (/api/settings-meta) enforces the only two guardrails: it
            # can't disconnect the credential powering this run, and reads come
            # back with secrets redacted. No activation gate, Settings is the
            # agent's own house, not a third-party MCP.
            settings_meta_server_path = os.path.join(
                os.path.dirname(__file__), "settings_meta_server.py"
            )
            from backend.auth import get_auth_token as _get_auth_token4
            mcp_servers["openswarm-settings-meta"] = {
                "command": sys.executable,
                "args": [settings_meta_server_path],
                "env": {
                    "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
                    "OPENSWARM_AUTH_TOKEN": _get_auth_token4(),
                    "OPENSWARM_PARENT_SESSION_ID": session.id,
                },
                "type": "stdio",
            }


            # Register the DDG-backed openswarm-web MCP only when the primary has no reliable
            # native Anthropic web path (decided in tools/web.py); _m feeds the registration log
            # + provider branch just below, so it stays a loop local.
            _m = _router_model_id if isinstance(_router_model_id, str) else ""
            need_web_mcp = should_register_web_mcp(
                model=session.model,
                router_model_id=_router_model_id,
                api_type=_api_type_for_session,
                anthropic_api_key=getattr(global_settings, "anthropic_api_key", None),
                connection_mode=getattr(global_settings, "connection_mode", "own_key"),
            )
            if need_web_mcp:
                web_mcp_server_path = os.path.join(
                    os.path.dirname(__file__), "web_mcp_server.py"
                )
                # Tell the MCP which primary the session is using so it
                # can route to that provider's native search tool.
                if _m.startswith(("gc/", "gemini/", "ag/")):
                    _primary_hint = "gemini"
                elif _m.startswith("cx/"):
                    _primary_hint = "openai"
                else:
                    _primary_hint = ""
                from backend.auth import get_auth_token as _get_auth_token3
                mcp_servers["openswarm-web"] = {
                    "command": sys.executable,
                    "args": [web_mcp_server_path],
                    "env": {
                        "OPENSWARM_PORT": backend_port,
                        "OPENSWARM_AUTH_TOKEN": _get_auth_token3(),
                        "OPENSWARM_PRIMARY_API": _primary_hint,
                    },
                    "type": "stdio",
                }
                logger.info(
                    f"[MCP-DEBUG] Primary {_m} has no reliable native web search, "
                    f"registering openswarm-web (DDG search + trafilatura fetch, free)"
                )

            effective_allowed = [
                t for t in session.allowed_tools
                if t in FULL_TOOLS and builtin_perms.get(t, "always_allow") == "always_allow"
            ]

            effective_disallowed = [
                t for t in FULL_TOOLS
                if builtin_perms.get(t, "always_allow") == "deny"
            ]

            if mcp_servers:
                all_tools_list = load_all_tools()
                for name in mcp_servers:
                    if name == "openswarm-browser-agent":
                        for bt in _browser_delegation_tools:
                            policy = builtin_perms.get(bt, "always_allow")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__openswarm-browser-agent__{bt}")
                            elif policy == "deny":
                                effective_disallowed.append(f"mcp__openswarm-browser-agent__{bt}")
                        continue

                    if name == "openswarm-invoke-agent":
                        for it in _invoke_agent_tools:
                            policy = builtin_perms.get(it, "always_allow")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__openswarm-invoke-agent__{it}")
                            elif policy == "deny":
                                effective_disallowed.append(f"mcp__openswarm-invoke-agent__{it}")
                        continue

                    if name == "openswarm-web":
                        # Expose our DDG-backed web tools under an MCP prefix.
                        # Honor existing WebSearch/WebFetch permission policy
                        #, if the user disabled them in Settings, don't offer
                        # the MCP variants either.
                        for wt in ("WebSearch", "WebFetch"):
                            policy = builtin_perms.get(wt, "always_allow")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__openswarm-web__{wt}")
                            elif policy == "deny":
                                effective_disallowed.append(f"mcp__openswarm-web__{wt}")
                        continue

                    tool_def = next(
                        (t for t in all_tools_list
                         if t.mcp_config and t.enabled and _sanitize_server_name(t.name) == name),
                        None,
                    )
                    if tool_def:
                        denied = get_denied_tool_names(tool_def)
                        known = get_all_known_tool_names(tool_def)
                        for tn in known - denied:
                            policy = tool_def.tool_permissions.get(tn, "ask")
                            if policy == "always_allow":
                                effective_allowed.append(f"mcp__{name}__{tn}")
                        for tn in denied:
                            effective_disallowed.append(f"mcp__{name}__{tn}")
                    else:
                        effective_allowed.append(f"mcp__{name}__*")

            # If the openswarm-web MCP was registered, the CLI's built-in
            # WebSearch/WebFetch are guaranteed to fail (no Anthropic
            # backend). Suppress them so the model picks our MCP variants
            # and doesn't waste a turn on a broken tool.
            if need_web_mcp:
                effective_allowed = [t for t in effective_allowed if t not in ("WebSearch", "WebFetch")]
                for _bt in ("WebSearch", "WebFetch"):
                    if _bt not in effective_disallowed:
                        effective_disallowed.append(_bt)

            # Tell the model directly which web tools work for this session.
            # The Claude Code CLI's deferred-tool registry still advertises bare
            # `WebSearch` and `WebFetch` even when we've stripped them above;
            # frontier models (Claude/GPT-5/Gemini Pro) intuit the namespaced
            # MCP variant from context, but smaller open-source models (gpt-oss
            # via Ollama, smaller Llama/Qwen, etc.) thrash on the deferred-tool
            # handshake (saw 2+ minutes of repeated `ToolSearch(select:WebSearch)`
            # → empty matches → retry). Naming the working tool here cuts that
            # to a single direct call. Only injected when (a) we registered the
            # web MCP, AND (b) the user hasn't disabled the policy, matches
            # the same gate the MCP allowlist uses, so disabling WebSearch in
            # Settings still wins.
            _web_tools_available = need_web_mcp and (
                "mcp__openswarm-web__WebSearch" in effective_allowed
                or "mcp__openswarm-web__WebFetch" in effective_allowed
            )
            if _web_tools_available:
                _hint_lines = ["<web_tools>"]
                _hint_lines.append(
                    "This session does NOT have the built-in `WebSearch` / "
                    "`WebFetch` tools (they delegate to Anthropic Haiku, which "
                    "isn't reachable on this primary). Use the MCP-backed "
                    "equivalents instead, call them DIRECTLY, no ToolSearch "
                    "step needed:"
                )
                if "mcp__openswarm-web__WebSearch" in effective_allowed:
                    _hint_lines.append(
                        "- `mcp__openswarm-web__WebSearch(query: str, "
                        "num_results?: int)`, DuckDuckGo search."
                    )
                if "mcp__openswarm-web__WebFetch" in effective_allowed:
                    _hint_lines.append(
                        "- `mcp__openswarm-web__WebFetch(url: str, prompt?: "
                        "str)`, fetch a URL and return readable text."
                    )
                _hint_lines.append(
                    "Do not call `ToolSearch(select:WebSearch)`, bare "
                    "`WebSearch` is unavailable on this session and that path "
                    "will return empty matches."
                )
                _hint_lines.append("</web_tools>")
                _web_hint = "\n".join(_hint_lines)
                composed_prompt = (
                    f"{composed_prompt}\n\n{_web_hint}" if composed_prompt else _web_hint
                )

            # Log effective tool lists
            google_allowed = [t for t in effective_allowed if "google-workspace" in t]
            reddit_allowed = [t for t in effective_allowed if "reddit" in t]
            builtin_allowed = [t for t in effective_allowed if not t.startswith("mcp__")]
            logger.info(f"[MCP-DEBUG] effective_allowed: {len(effective_allowed)} total "
                        f"(builtins={len(builtin_allowed)}, google={len(google_allowed)}, reddit={len(reddit_allowed)})")
            if effective_disallowed:
                logger.info(f"[MCP-DEBUG] effective_disallowed: {effective_disallowed}")

            # `_router_model_id` and `_api_type_for_session` were resolved
            # at the top of _run_agent_loop (before any closures were
            # defined) so analytics closures could tag events with them.
            # Reuse those values here and keep session.provider in sync.
            resolved_model = _router_model_id
            api_type = _api_type_for_session
            session.provider = api_type

            # Capture the Claude CLI's stderr into a buffer so the retry
            # classifier can see the real cause of a process crash (e.g.
            # "No pool capacity available" from the OpenSwarm proxy, or the
            # Anthropic SDK's 429/overloaded error body). Without this the
            # SDK's ProcessError only stringifies to "Command failed with
            # exit code 1 / Check stderr output for details", which masks
            # transient capacity issues.
            _stderr_buffer: list[str] = []

            def _stderr_cb(line: str) -> None:
                _stderr_buffer.append(line)
                # Cap the buffer so a runaway subprocess can't balloon RAM.
                if len(_stderr_buffer) > 500:
                    del _stderr_buffer[:250]

            async def stop_hook(input_data, tool_use_id, context):
                return await stop_hook_mod.stop_hook(hook_ctx, input_data, tool_use_id, context)

            options_kwargs = {
                "model": resolved_model,
                # 64 MB ceiling on the SDK <-> CLI JSON-RPC channel. The
                # default 5 MB blocked any base64'd PDF over ~3.5 MB; we
                # now route PDFs/images as native content blocks, which
                # base64-expand by ~33%. 64 MB clears the largest single
                # Anthropic PDF (32 MB raw) with headroom for prompt +
                # tool results sharing the same frame.
                "max_buffer_size": 64 * 1024 * 1024,
                "permission_mode": "default",
                "can_use_tool": can_use_tool,
                "stderr": _stderr_cb,
                "hooks": {
                    "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
                    "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
                    "Stop": [HookMatcher(matcher=None, hooks=[stop_hook])],
                },
                "allowed_tools": effective_allowed,
                "disallowed_tools": effective_disallowed,
                "include_partial_messages": True,
            }
            # cc/cx/gc/ag/gemini/openrouter prefixes force 9Router; route="api"
            # bypasses to the provider's host directly; otherwise Pro proxy or key.
            from backend.apps.nine_router import is_running as _9r_running
            from backend.apps.agents.providers.registry import _NINEROUTER_MODEL_PREFIXES
            resolved_is_9router = isinstance(resolved_model, str) and resolved_model.startswith(_NINEROUTER_MODEL_PREFIXES)

            from backend.apps.agents.providers.registry import _find_builtin_model
            _model_entry = _find_builtin_model(session.model)
            _is_pinned_api_route = (
                _model_entry is not None
                and _model_entry.get("route") == "api"
            )
            _api_route_provider = (_model_entry or {}).get("api") if _is_pinned_api_route else None

            if _is_pinned_api_route and _api_route_provider == "anthropic" and getattr(global_settings, "anthropic_api_key", None):
                options_kwargs["env"] = {
                    "ANTHROPIC_API_KEY": global_settings.anthropic_api_key,
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    # Pin subagent envs so they don't drift back to the proxy.
                    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
                    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
                }
                logger.info(f"[MCP-DEBUG] Using direct Anthropic API key (route=api) for {session.model}")
            elif _is_pinned_api_route and _api_route_provider == "openai" and getattr(global_settings, "openai_api_key", None):
                # Goes through 9Router's Anthropic→OpenAI translator like
                # other own-key routes, but we point OPENAI_BASE_URL at a
                # tiny local pass-through (/api/openai-passthrough/v1) that
                # renames max_tokens → max_completion_tokens before relaying
                # to api.openai.com. OpenAI's GPT-5 family rejects max_tokens
                # with HTTP 400, and 9Router 0.3.60 doesn't know about
                # max_completion_tokens yet (its CLI<->OpenAI translator
                # emits the legacy field). The pin on 0.3.60 is intentional
                # (newer 9Router versions regress WebSearch, see
                # nine_router.py comment) so we patch the boundary instead
                # of bumping. Pre-fix: every gpt-5.* / gpt-5.* own-key
                # session 400'd silently.
                from backend.auth import get_auth_token as _get_auth_token_o
                _passthrough_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/openai-passthrough/v1"
                options_kwargs["env"] = {
                    "OPENAI_API_KEY": global_settings.openai_api_key,
                    "OPENAI_BASE_URL": _passthrough_url,
                    "ANTHROPIC_API_KEY": _get_auth_token_o() or "9router",
                    "ANTHROPIC_BASE_URL": "http://localhost:20128",
                }
                logger.info(f"[MCP-DEBUG] Using direct OpenAI API key (route=api) for {session.model} via openai-passthrough")
            elif _is_pinned_api_route and _api_route_provider == "custom":
                # User-configured OpenAI-compatible endpoint (Ollama Cloud,
                # Together, local Ollama, etc.). Routes through 9Router's
                # openai-compatible provider node we synced from settings.
                from backend.apps.nine_router import ensure_running as _9r_ensure_c
                if not _9r_running():
                    logger.info(f"[MCP-DEBUG] custom provider selected but 9Router not running; waiting for startup")
                    await _9r_ensure_c()
                    if not _9r_running():
                        raise ValueError(
                            "9Router could not start. Custom OpenAI-compatible "
                            "providers need 9Router to translate the Anthropic "
                            "protocol, install Node.js and restart the app."
                        )
                from backend.apps.agents.providers.registry import _find_custom_provider_for_value
                cp = _find_custom_provider_for_value(global_settings, session.model)
                env = {
                    "ANTHROPIC_API_KEY": "9router",
                    "ANTHROPIC_BASE_URL": "http://localhost:20128",
                    "ENABLE_TOOL_SEARCH": "auto",
                }
                if cp:
                    # Local OpenAI-compatible servers (LM Studio, Ollama, ...)
                    # often run with auth disabled, the user leaves api_key
                    # blank in Settings. The OpenAI-style SDK insists on a
                    # non-empty key; substitute a harmless placeholder so the
                    # CLI can issue requests. Servers that DO check auth always
                    # have a real key configured.
                    env["OPENAI_API_KEY"] = (cp.api_key or "").strip() or "no-auth-required"
                    from backend.apps.nine_router import normalize_openai_compat_base_url as _norm_cp_url
                    env["OPENAI_BASE_URL"] = _norm_cp_url(cp.base_url or "")
                # Pin subagent ids, without these, CLI's default Haiku 4.5
                # gets sent to the custom provider and 404s.
                if global_settings.anthropic_api_key:
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-sonnet-4-6"
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = "claude-haiku-4-5-20251001"
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "claude-haiku-4-5-20251001"
                else:
                    # Pin to the same custom-provider model so subagents stay
                    # within the user's configured endpoint instead of hitting
                    # an unconfigured Anthropic lane.
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = resolved_model
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = resolved_model
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = resolved_model
                options_kwargs["env"] = env
                logger.info(f"[MCP-DEBUG] Using custom provider for {session.model} → {resolved_model}")
            elif _is_pinned_api_route and _api_route_provider == "gemini" and getattr(global_settings, "google_api_key", None):
                # Routed through the local anthropic-proxy so it can scrub the
                # JSON-Schema fields Gemini's API rejects ($schema, additionalProperties,
                # propertyNames, exclusiveMinimum, nested const) that 9Router 0.3.60 misses.
                from backend.auth import get_auth_token as _get_auth_token_g
                _proxy_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
                options_kwargs["env"] = {
                    "GEMINI_API_KEY": global_settings.google_api_key,
                    "GOOGLE_API_KEY": global_settings.google_api_key,
                    "ANTHROPIC_API_KEY": _get_auth_token_g() or "9router",
                    "ANTHROPIC_BASE_URL": _proxy_url,
                }
                logger.info(f"[MCP-DEBUG] Using direct Google API key (route=api) for {session.model} via local proxy")
            elif api_type == "openrouter" and getattr(global_settings, "openrouter_api_key", None):
                # OpenRouter primary. The route="openrouter" entry's
                # router_model_id is `openrouter/<vendor>/<model>` so
                # 9Router routes via the apikey connection synced from
                # CLI's WebSearch delegation needs an Anthropic-shaped lane;
                # if the user has no Anthropic key/sub/Pro, fall back to OR's
                # resold Claude so subagents stay on the same OR billing.
                if not _9r_running():
                    from backend.apps.nine_router import ensure_running as _9r_ensure
                    logger.info(f"[MCP-DEBUG] OpenRouter selected but 9Router not running; waiting for startup")
                    await _9r_ensure()
                    if not _9r_running():
                        raise ValueError(
                            "9Router could not start. OpenRouter routing requires "
                            "Node.js, install it and restart the app, or pick a "
                            "model that uses a direct API key (Anthropic, OpenAI, "
                            "or Google AI Studio)."
                        )
                env = {
                    "ANTHROPIC_API_KEY": "9router",
                    "ANTHROPIC_BASE_URL": "http://localhost:20128",
                }
                if global_settings.anthropic_api_key:
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-sonnet-4-6"
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = "claude-haiku-4-5-20251001"
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "claude-haiku-4-5-20251001"
                else:
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = "openrouter/anthropic/claude-sonnet-4.5"
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = "openrouter/anthropic/claude-haiku-4.5"
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = "openrouter/anthropic/claude-haiku-4.5"
                env["ENABLE_TOOL_SEARCH"] = "auto"
                options_kwargs["env"] = env
                logger.info(f"[MCP-DEBUG] Using OpenRouter for {session.model}")
            elif api_type == "anthropic" and not resolved_is_9router and getattr(global_settings, "connection_mode", "own_key") in ("openswarm-pro", "free-trial"):
                from backend.apps.settings.credentials import proxy_auth
                bearer, proxy_url = proxy_auth(global_settings)
                bearer = bearer or ""
                options_kwargs["env"] = {
                    "ANTHROPIC_AUTH_TOKEN": bearer,
                    "ANTHROPIC_BASE_URL": proxy_url,
                    # Pin subagent ids; CLI default 'claude-haiku-4-5-20251001'
                    # gets rejected by Pro's surface as "No credentials for provider: anthropic".
                    # (Free-trial clamps to its allowed Claude set + weights credits server-side.)
                    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
                    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5-20251001",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001",
                    # auto, never the bare default: tengu_defer_all_bn4 marks every tool
                    # defer_loading=true, which collides with our cache_control and 400s the
                    # first tool-laden request (the other anthropic branches all set this).
                    "ENABLE_TOOL_SEARCH": "auto",
                }
                # Free lane meters one run per agent task: tag every call of this task (and its
                # subagents, which inherit the env) AND its aux calls (title-gen, see generate_title)
                # with the session id, so a query plus its title generation is ONE run, not two.
                # The base goes straight to the cloud (no 9Router), so the header rides through.
                if getattr(global_settings, "connection_mode", "own_key") == "free-trial":
                    options_kwargs["env"]["ANTHROPIC_CUSTOM_HEADERS"] = f"X-Openswarm-Task-Id: {session.id}"
                    # The cloud serves every free run as Haiku, so keep the subagent on Haiku too:
                    # a sonnet subagent makes the CLI attach `effort`, which Haiku 400s on.
                    options_kwargs["env"]["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude-haiku-4-5-20251001"
                logger.info(f"[MCP-DEBUG] Using OpenSwarm cloud proxy at {proxy_url}")
            elif api_type == "anthropic" and not resolved_is_9router and global_settings.anthropic_api_key:
                options_kwargs["env"] = {"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}
                logger.info("[MCP-DEBUG] Using direct Anthropic API key")
            elif _9r_running():
                # Gemini-bound ids go through the local proxy for schema scrubbing;
                # everything else hits 9Router directly.
                _is_gemini_bound = (
                    isinstance(resolved_model, str)
                    and resolved_model.startswith(("gemini/", "gc/", "ag/"))
                )
                if _is_gemini_bound:
                    from backend.auth import get_auth_token as _get_auth_token_g2
                    _base_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
                    env = {
                        "ANTHROPIC_API_KEY": _get_auth_token_g2() or "9router",
                        "ANTHROPIC_BASE_URL": _base_url,
                    }
                else:
                    env = {
                        "ANTHROPIC_API_KEY": "9router",
                        "ANTHROPIC_BASE_URL": "http://localhost:20128",
                    }
                # Pin subagent ids to whichever lane the user has, else CLI's
                # default Haiku 4.5 hits 9Router with no Claude route and 401s.
                try:
                    _sub_conns = _conns  # reuse list fetched above
                except NameError:
                    _sub_conns = []
                _active = {c.get("provider") for c in _sub_conns
                           if isinstance(c, dict) and c.get("isActive")}
                _sub_model = None
                _small_model = None
                if global_settings.anthropic_api_key:
                    _sub_model = "claude-sonnet-4-6"
                    _small_model = "claude-haiku-4-5-20251001"
                elif "claude" in _active or "anthropic" in _active:
                    _sub_model = "cc/claude-sonnet-4-6"
                    _small_model = "cc/claude-haiku-4-5-20251001"
                elif "antigravity" in _active:
                    _sub_model = "ag/gemini-3-flash"
                    _small_model = "ag/gemini-3-flash"
                elif "gemini-cli" in _active:
                    _sub_model = "gc/gemini-2.5-flash"
                    _small_model = "gc/gemini-2.5-flash"
                elif "codex" in _active:
                    _sub_model = "cx/gpt-5.4-mini"
                    _small_model = "cx/gpt-5.4-mini"
                if _sub_model:
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = _sub_model
                if _small_model:
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = _small_model
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = _small_model
                logger.info(
                    f"[MCP-DEBUG] 9Router direct, subagent_model={_sub_model}, small_fast={_small_model}"
                )
                # ENABLE_TOOL_SEARCH=auto: without it, CLI's tengu_defer_all_bn4
                # Statsig flag defers 16 tools with no way to load them on non-
                # Anthropic networks. "auto" eagerly loads tools when schema
                # budget fits in ~10% of context. Don't pass --bare, sets
                # CLAUDE_CODE_SIMPLE=1 which strips the system prompt scaffolding.
                env["ENABLE_TOOL_SEARCH"] = "auto"
                options_kwargs["env"] = env
                logger.info(f"[MCP-DEBUG] Using 9Router (api_type={api_type})")
            else:
                if api_type != "anthropic":
                    from backend.apps.nine_router import ensure_running as _9r_ensure
                    logger.info(f"[MCP-DEBUG] 9Router not running for non-Anthropic model {session.model}; waiting for startup")
                    await _9r_ensure()
                    if _9r_running():
                        options_kwargs["env"] = {
                            "ANTHROPIC_API_KEY": "9router",
                            "ANTHROPIC_BASE_URL": "http://localhost:20128",
                        }
                        logger.info(f"[MCP-DEBUG] 9Router started; routing {session.model} via 9Router")
                    else:
                        raise ValueError(
                            f"9Router is not running; cannot use {session.model}. "
                            "Install Node.js and restart the app, or switch to a model "
                            "with a direct API key."
                        )
                else:
                    raise ValueError("No AI provider configured. Set an API key or connect a subscription.")
            if mcp_servers:
                options_kwargs["mcp_servers"] = mcp_servers
                mcp_json_len = len(json.dumps({"mcpServers": mcp_servers}))
                logger.info(f"[MCP-DEBUG] mcp_servers passed to SDK: {list(mcp_servers.keys())}, JSON length={mcp_json_len}")
            # claude_code preset for BOTH system_prompt and tools so the CLI's
            # deferred-tools scaffolding survives. Raw string would replace it.
            options_kwargs["tools"] = {
                "type": "preset",
                "preset": "claude_code",
            }
            # exclude_dynamic_sections=True moves cwd/git/OS grounding out of
            # the cached prefix and into the first user message, unlocks
            # Anthropic prompt cache (~80% input-token cut, 13-31% faster TTFT).
            # Trade-off: grounding freezes at turn 1.
            if composed_prompt:
                options_kwargs["system_prompt"] = {
                    "type": "preset",
                    "preset": "claude_code",
                    "append": composed_prompt,
                    "exclude_dynamic_sections": True,
                }
            else:
                options_kwargs["system_prompt"] = {
                    "type": "preset",
                    "preset": "claude_code",
                    "exclude_dynamic_sections": True,
                }
            if session.max_turns:
                options_kwargs["max_turns"] = session.max_turns

            # The claude_code preset auto-attaches the user's claude.ai-
            # connected partner MCPs (`mcp__claude_ai_*`). Those bypass our
            # MCPActivate gate, don't share OAuth state with the OpenSwarm
            # Gmail/Calendar/Drive connectors the user actually configured
            # here, and confuse the model into picking the partner shim
            # instead of our vetted server. Hard-block them at the SDK
            # layer so the model can't even attempt the call.
            options_kwargs["disallowed_tools"] = [
                "mcp__claude_ai_*",
            ]

            if session.cwd:
                # Pre-existing sessions may have workspaces that predate
                # the git-init block in launch_agent, leaving them
                # without a valid HEAD. Ensure it here so subagent
                # worktree-add always works.
                _ensure_cwd_git_repo(session.cwd)
                options_kwargs["cwd"] = session.cwd

            try:
                level = getattr(session, "thinking_level", "auto") or "auto"
                # Trivially short prompts ("hi", "thanks") don't benefit from
                # 5-30s of hidden reasoning. Override per-turn only, session
                # setting is untouched so the UI pill keeps reflecting the
                # user's choice.
                _prompt_len = len((prompt or "").strip())
                if 0 < _prompt_len < 50 and level != "off":
                    level = "off"
                # gc/gemini-3* without Antigravity 400s every multi-step turn
                # on thoughtSignature continuity. Force-disable thinking.
                if (
                    isinstance(resolved_model, str)
                    and resolved_model.startswith("gc/gemini-3")
                    and level != "off"
                ):
                    logger.info(
                        "Forcing thinking_level=off for %s (gc/ thoughtSignature isn't roundtrippable; connect Antigravity for reasoning).",
                        resolved_model,
                    )
                    level = "off"
                if api_type == "anthropic":
                    if level == "off":
                        # Fable 5 400s on an explicit thinking:disabled; you turn it
                        # off there by omitting the param (off is Fable's default).
                        if not (isinstance(resolved_model, str) and "fable" in resolved_model):
                            options_kwargs["thinking"] = {"type": "disabled"}
                    elif level in ("low", "medium", "high"):
                        options_kwargs["effort"] = level
                elif api_type in ("openai", "codex"):
                    # GPT-5 family + Codex take reasoning_effort; 9Router carries
                    # the Anthropic-shaped `effort` across to it, so the slider
                    # works for OpenAI too, not just Claude. Every OpenAI/Codex
                    # model we expose is reasoning-capable (registry has no
                    # non-reasoning ones), so no per-model gate. No "disabled"
                    # form on these, so "off" just omits the param.
                    if level in ("low", "medium", "high"):
                        options_kwargs["effort"] = level
            except Exception as e:
                logger.debug(f"thinking_level param injection skipped: {e}")

            # Fresh-restart path: some session changes must not reuse the
            # CLI's resume transcript. MCPActivate needs a new transport so
            # tool schemas are reread; branch edits/switches need the model
            # to see only _get_branch_messages(session), not facts from the
            # old branch's SDK transcript. Soft restart: drop resume +
            # sdk_session_id, replay local history via the prompt, let the
            # SDK build a clean session from the current app state.
            if session.needs_fresh_session:
                if session.sdk_session_id:
                    logger.info(
                        f"Fresh-session restart for {session_id}: dropping "
                        f"sdk_session_id={session.sdk_session_id}; active_mcps={session.active_mcps}"
                    )
                    session.sdk_session_id = None
                session.needs_fresh_session = False
                session.needs_fork = False  # superseded by the fresh restart

            if session.sdk_session_id:
                options_kwargs["resume"] = session.sdk_session_id
                if fork_session or session.needs_fork:
                    options_kwargs["fork_session"] = True
                if session.needs_fork:
                    session.needs_fork = False
            elif len(session.messages) > 1:
                history = _build_history_prefix(
                    _get_branch_messages(session),
                    cutoff_msg_id=session.compacted_through_msg_id,
                )
                if history:
                    if isinstance(prompt_content, str):
                        prompt_content = history + "\n\n" + prompt_content
                    elif isinstance(prompt_content, list):
                        prompt_content.insert(0, {"type": "text", "text": history})

            # Compaction trigger (Phase 2). Driven by live ctx_used ratio
            # rather than turn count, fires when input_tokens/context_window
            # crosses session.compact_threshold_pct (default 0.65). Cheap,
            # programmatic summarization (no aux LLM call) so this adds
            # zero latency on the user's turn.
            try:
                if self._maybe_compact(session):
                    new_input = _estimate_post_compact_input(session)
                    await ws_manager.send_to_session(session_id, "agent:context_status", {
                        "session_id": session_id,
                        "reason": "compacted",
                        "compacted_through_msg_id": session.compacted_through_msg_id,
                    })
                    await self._emit_context_update(
                        session_id,
                        session,
                        input_tokens=new_input,
                        output_tokens=session.tokens.get("output", 0),
                    )
            except Exception:
                logger.exception("compaction failed; proceeding without it")

            # Pre-send hard guard (Phase 2). After compaction, if the
            # session is still over context_soft_cap_pct of the window,
            # LRU-trim oldest active_mcps. Stops the 429 from ever
            # firing on predictable overflow paths.
            try:
                # Use the most recent measurement (the prior turn's
                # input_tokens) as the estimate. Conservative because the
                # current turn's user prompt + any new history adds on top
                #, but the first turn of a fresh session has tokens=0 so
                # we only act once we've seen real numbers.
                _est_tokens = session.tokens.get("input", 0)
                _hard_cap = int(session.context_window * session.context_soft_cap_pct)
                if _est_tokens >= _hard_cap:
                    trimmed: list[str] = []
                    while _est_tokens >= _hard_cap and len(session.active_mcps) > 1:
                        # Keep at least one MCP active so the model can
                        # finish whatever it was doing; trim from oldest
                        # which is FIFO order in the list.
                        trimmed.append(f"mcp:{session.active_mcps.pop(0)}")
                        _est_tokens -= 8_000  # rough per-MCP schema cost
                    if trimmed:
                        await ws_manager.send_to_session(session_id, "agent:context_status", {
                            "session_id": session_id,
                            "reason": "trimmed",
                            "trimmed": trimmed,
                            "estimate_after": _est_tokens,
                        })
                        # Surface a visible system breadcrumb in the chat so
                        # the user (and the model on the next turn) know
                        # which MCPs got dropped. Without this, the model
                        # may keep trying to call a now-missing tool and
                        # the user has no idea why.
                        try:
                            _names = ", ".join(t.replace("mcp:", "") for t in trimmed)
                            _trim_msg = Message(
                                role="system",
                                content=(
                                    f"Trimmed {len(trimmed)} app{'s' if len(trimmed) != 1 else ''} from this session to fit "
                                    f"the model's context: {_names}. Re-activate via MCPSearch + MCPActivate "
                                    "if you still need them."
                                ),
                                branch_id=session.active_branch_id,
                            )
                            session.messages.append(_trim_msg)
                            await ws_manager.send_to_session(session_id, "agent:message", {
                                "session_id": session_id,
                                "message": _trim_msg.model_dump(mode="json"),
                            })
                        except Exception:
                            logger.exception("failed to emit MCP-trimmed breadcrumb")
                        # Trimming changes mcp_servers / outputs context →
                        # rebuild options. The cheapest correct path is
                        # to flag for fork on next turn via needs_fork
                        # and let the existing fork path handle it.
                        session.needs_fork = True
            except Exception:
                logger.exception("pre-send token guard failed; proceeding")

            logger.info(f"[MCP-DEBUG] Creating ClaudeAgentOptions short={session.model} resolved={resolved_model} api_type={api_type}")
            options = ClaudeAgentOptions(**options_kwargs)
            logger.info(f"[MCP-DEBUG] ClaudeAgentOptions created. Starting query...")

            async def prompt_stream():
                yield {
                    "type": "user",
                    "message": {"role": "user", "content": prompt_content},
                }

            turn = TurnState()
            # Mirror of the streamed assistant text. The SDK envelope that
            # normally commits a reply never lands when a turn is stopped
            # mid-stream, so without this the text the user just watched
            # appear would evaporate. Cleared the instant a block commits.
            # Per-turn aggregate trackers for the consolidated thinking
            # message. We accumulate across every AssistantMessage in the
            # turn (think → tool → think → tool → answer) and stream
            # incremental updates to the SAME persisted Message id so the
            # ThinkingBubble pill ticks live: "Thought for 18s · 412
            # tokens · 3 tools used". Reset only at turn boundaries.
            thinking = ThinkingState()
            # Persistent id for the turn's single thinking message. We
            # reuse it across multi-step turns so the frontend's
            # addMessage dedupe replaces the bubble in place rather
            # than stacking N pills above the answer. Reset at the
            # next user turn (next prompt_stream iteration).
            # Wall-clock turn duration (ms), covers thinking + tool
            # execution + assistant text. Updated continuously as the
            # turn unfolds. Used for the "Thought for Ns" segment so
            # the duration reflects the entire user-visible wait, not
            # just thinking-only time.
            # Total output tokens across every AssistantMessage in the
            # turn (thinking + visible text + tool-call JSON args). The
            # consolidated thinking pill's `tokens` segment uses this
            # rather than thinking-text-only chars/3.6, answers the
            # question "how much work did the model produce on this
            # turn" honestly. Populated from each AssistantMessage's
            # usage.output_tokens; fallback heuristic kicks in only
            # when usage is absent.
            # Running char counts for the streaming portions of the
            # turn, used to grow the token estimate while assistant
            # text and tool-call JSON args are still streaming, BEFORE
            # the SDK has emitted a final usage.output_tokens count
            # for those blocks. Once the AssistantMessage lands with
            # real usage data, turn.output_tokens supersedes these.
            # Latest Gemini thoughtSignature captured from this turn's
            # ThinkingBlocks. We persist it on the consolidated thinking
            # Message so subsequent turns can re-attach it to the
            # assistant turn we feed back to Gemini, satisfying
            # Google's reasoning-continuity check (the source of the
            # "Thought signature is not valid" 400). None for providers
            # that don't use signatures.
            # session.tokens accumulates SDK running totals across turns,
            # so subtract the turn-start baseline to get this turn's delta.
            # Background ticker handle. Re-emits the consolidated
            # thinking message every 1s so the elapsed counter keeps
            # ticking through gaps where no SDK events fire (tool
            # execution, slow text generation). Started at first
            # AssistantMessage of the turn, cancelled at ResultMessage.
            # True between the first non-ResultMessage of a turn and the
            # following ResultMessage; False at turn boundaries. The retry
            # layer below only retries at boundaries, resuming mid-turn via
            # sdk_session_id would risk duplicating user-visible output.

            # Silently absorb transient upstream capacity errors (429/500/503/
            # 529/overloaded/network blips) by waiting with exponential
            # backoff and restarting the query with resume=sdk_session_id.
            # The session keeps its conversation state across retries so the
            # user just sees a pause, not a red error card. Hard errors
            # (auth, plan limit, invalid args) fall through to the existing
            # error handler unchanged.

            async def _run_streaming_turn():
                # Per-turn thinking aggregation trackers (added for the
                # "Thought for Ns · M tokens" persisted label). Without
                # nonlocal, the int reassignments at AssistantMessage emission
                # below shadow them as locals and the dict access at
                # content_block_start crashes with UnboundLocalError.
                async for message in query(
                    prompt=prompt_stream(),
                    options=options,
                ):
                    if isinstance(message, ResultMessage):
                        turn.current_turn_emitted = False
                    else:
                        turn.current_turn_emitted = True
                        # Stamp the turn's wall-clock start at the FIRST
                        # non-Result message we see, this is when the
                        # user actually started waiting. We use the same
                        # timestamp as the basis for "Thought for Ns"
                        # so the duration covers thinking + tool exec
                        # + assistant text generation.
                        if turn.started_ts is None:
                            turn.started_ts = time.time()
                            # Snapshot cumulative tokens at turn start;
                            # subtracted at emit time for per-turn deltas.
                            try:
                                # Baselines track the SAME fresh lane the pill reads,
                                # so the per-turn delta is fresh-minus-fresh.
                                if isinstance(session.tokens, dict):
                                    turn.baseline_session_in = int(session.tokens.get("input_fresh", 0) or 0)
                                    turn.baseline_session_out = int(session.tokens.get("output", 0) or 0)
                                _ch_in = 0
                                _ch_out = 0
                                for _child in self.sessions.values():
                                    if getattr(_child, "parent_session_id", None) != session.id:
                                        continue
                                    _ct = getattr(_child, "tokens", None)
                                    if not isinstance(_ct, dict):
                                        continue
                                    _ch_in += int(_ct.get("input_fresh", 0) or 0)
                                    _ch_out += int(_ct.get("output", 0) or 0)
                                turn.baseline_children_in = _ch_in
                                turn.baseline_children_out = _ch_out
                                turn.baseline_captured = True
                            except Exception:
                                pass
                            # Pre-emit thinking pill for routes whose
                            # translator strips reasoning content (cx/, gc/,
                            # ag/, gemini/). Without this, the pill emits
                            # at turn end and lands BELOW the assistant
                            # text in session.messages, visually wrong.
                            # Pre-emitting here gives the pill the same
                            # ordering as Anthropic's natural streaming
                            # path. Updates in place at turn end via the
                            # stable thinking.msg_id dedupe.
                            try:
                                _route_strips_reasoning_pre = (
                                    isinstance(resolved_model, str)
                                    and resolved_model.startswith(("cx/", "gc/", "ag/", "gemini/"))
                                )
                                if _route_strips_reasoning_pre:
                                    await thinking_mod.emit_consolidated_thinking(thinking, turn, session, session_id, self.sessions, force_provider_unavailable=True)
                            except Exception:
                                logger.exception("pre-emit thinking pill failed; continuing")

                    if turn.first_event:
                        logger.info(f"[MCP-DEBUG] First event received: {type(message).__name__}")
                        turn.first_event = False

                    # Log system messages (MCP server status, errors, etc.)
                    if isinstance(message, SystemMessage):
                        raw = message.__dict__ if hasattr(message, '__dict__') else str(message)
                        logger.info(f"[MCP-DEBUG] SystemMessage: {raw}")

                    if isinstance(message, StreamEvent):
                        await stream_event.handle_stream_event(
                            message, session, session_id, turn, thinking, self._live_partial
                        )

                    elif isinstance(message, AssistantMessage):
                        await assistant_message.handle_assistant_message(
                            message, session, session_id, turn, thinking, self._live_partial, self.sessions
                        )
                    elif isinstance(message, ResultMessage):
                        # ResultMessage carries the AUTHORITATIVE per-turn
                        # output_tokens count. Some providers (notably
                        # OpenAI/Gemini through 9Router) only populate
                        # `usage.output_tokens` here, not on individual
                        # AssistantMessages. Fold this into the running
                        # turn aggregate BEFORE emitting the final
                        # consolidated thinking message, so the bubble's
                        # tokens segment reflects ground truth on those
                        # providers too.
                        try:
                            _result_usage = getattr(message, "usage", None) or {}
                            if isinstance(_result_usage, dict):
                                _result_out = int(_result_usage.get("output_tokens", 0) or 0)
                                # Take the max, if individual
                                # AssistantMessages already summed to a
                                # larger number we trust that; otherwise
                                # ResultMessage's count fills the gap.
                                if _result_out > turn.output_tokens:
                                    turn.output_tokens = _result_out
                        except Exception:
                            pass

                        # Pre-populate session.tokens BEFORE emitting the
                        # final consolidated thinking pill. Order matters:
                        # emit_consolidated_thinking reads
                        # session.tokens["input"]/["output"] for the
                        # combined-total stamp on the pill. If we emit
                        # first, the pill freezes with input=0 because
                        # the ResultMessage hasn't been consumed yet
                        # (the writes below at line ~2918 wouldn't
                        # land until after the pill is already broadcast).
                        try:
                            _pre_usage = getattr(message, "usage", None) or {}
                            if isinstance(_pre_usage, dict):
                                _pre_in = int(_pre_usage.get("input_tokens", 0) or 0)
                                _pre_create = int(_pre_usage.get("cache_creation_input_tokens", 0) or 0)
                                _pre_read = int(_pre_usage.get("cache_read_input_tokens", 0) or 0)
                                _pre_total_in = _pre_in + _pre_create + _pre_read
                                _pre_out = int(_pre_usage.get("output_tokens", 0) or 0)
                                if _pre_total_in > 0:
                                    session.tokens["input"] = _pre_total_in
                                # Pill reads the fresh lane: uncached input only,
                                # so re-read/cached context doesn't inflate it.
                                session.tokens["input_fresh"] = _pre_in
                                if _pre_out > 0:
                                    session.tokens["output"] = _pre_out
                        except Exception:
                            pass

                        # Final consolidated emission with the full
                        # duration + authoritative tokens. The frontend
                        # bubble freezes on this final value.
                        # For routes whose translator strips reasoning
                        # content (cx/ for OpenAI, gc/ for Gemini),
                        # force-emit a pill even when no text or upstream
                        # token count was captured. Without this, GPT/
                        # Gemini turns show no thinking bubble at all
                        # because 9Router's translator doesn't carry
                        # reasoning_content across the Anthropic-shape
                        # round-trip. The frontend's ThinkingBubble
                        # detects empty content and renders a friendly
                        # "provider doesn't expose reasoning text"
                        # explanation instead of a blank panel.
                        _route_strips_reasoning = (
                            isinstance(resolved_model, str)
                            and resolved_model.startswith(("cx/", "gc/", "ag/", "gemini/"))
                        )
                        if thinking.text_parts or _route_strips_reasoning:
                            try:
                                await thinking_mod.emit_consolidated_thinking(
                                    thinking, turn, session, session_id, self.sessions,
                                    force_provider_unavailable=_route_strips_reasoning,
                                )
                            except Exception:
                                pass
                        if thinking.ticker_task is not None and not thinking.ticker_task.done():
                            thinking.ticker_task.cancel()
                            try:
                                await thinking.ticker_task
                            except (asyncio.CancelledError, Exception):
                                pass
                        thinking.ticker_task = None
                        thinking.msg_id = None
                        thinking.text_parts = []
                        turn.tool_count = 0
                        turn.started_ts = None
                        turn.total_ms = 0
                        turn.output_tokens = 0
                        turn.assistant_text_chars = 0
                        turn.tool_input_chars = 0
                        thinking.thought_signature = None
                        turn.baseline_session_in = 0
                        turn.baseline_session_out = 0
                        turn.baseline_children_in = 0
                        turn.baseline_children_out = 0
                        turn.baseline_captured = False
                        thinking.total_ms = 0
                        thinking.total_chars = 0
                        thinking.block_starts = {}

                        session.sdk_session_id = getattr(message, "session_id", None)
                        # Pull usage first; SDK's total_cost_usd is wrong for OR
                        # (assumes Anthropic rates) and we recompute below.
                        usage = getattr(message, "usage", None) or {}
                        inp = out = cache_create = cache_read = total_input = 0
                        if isinstance(usage, dict):
                            inp = usage.get("input_tokens", 0) or 0
                            out = usage.get("output_tokens", 0) or 0
                            cache_create = usage.get("cache_creation_input_tokens", 0) or 0
                            cache_read = usage.get("cache_read_input_tokens", 0) or 0
                            total_input = inp + cache_create + cache_read
                            session.tokens["input"] = total_input
                            session.tokens["input_fresh"] = inp
                            session.tokens["output"] = out

                        cost = getattr(message, "total_cost_usd", None)
                        if cost is not None:
                            _free_route = False
                            if isinstance(resolved_model, str):
                                if resolved_model.startswith(("cc/", "cx/", "gc/", "ag/")):
                                    _free_route = True
                                elif resolved_model.startswith("openrouter/") and ":free" in resolved_model:
                                    _free_route = True
                                elif resolved_model.startswith("cp-"):
                                    # User-configured custom OpenAI-compatible
                                    # provider (Ollama Cloud, Together, Groq,
                                    # local LMs, etc.). Pricing is unknowable
                                    # without per-provider rate tables that
                                    # would rot fast, zero out instead of
                                    # showing the SDK's Anthropic-rate
                                    # estimate, which is meaningless here.
                                    _free_route = True
                            if api_type == "anthropic":
                                from backend.apps.settings.credentials import proxy_auth as _proxy_auth
                                _pa_tok, _ = _proxy_auth(global_settings)
                                # Pro and free-trial both run server-funded, so per-token cost to the user is 0.
                                if _pa_tok:
                                    _free_route = True

                            if _free_route:
                                cost = 0.0
                            elif isinstance(resolved_model, str) and resolved_model.startswith("openrouter/"):
                                # SDK assumes Anthropic rates → 50-100× off for OR.
                                from backend.apps.agents.providers.registry import get_openrouter_pricing
                                pricing = get_openrouter_pricing(resolved_model)
                                if pricing:
                                    in_rate, out_rate = pricing
                                    cost = (
                                        (inp + cache_create + cache_read) * in_rate
                                        + out * out_rate
                                    ) / 1_000_000
                            elif api_type in ("openai", "gemini") or (
                                isinstance(resolved_model, str)
                                and (resolved_model.startswith("cp-openai/")
                                     or resolved_model.startswith("cp-gemini/")
                                     or resolved_model.startswith("cp-google/"))
                            ):
                                # Direct OpenAI/Gemini API key lane. SDK's
                                # total_cost_usd is computed at Anthropic
                                # rates (Opus pricing), for GPT-5.4-Mini
                                # at $0.25/M input that's a 60x overcount
                                # ($30 instead of $0.04 per Mehmet-style
                                # 4-PDF turn). Use the published per-model
                                # rates instead.
                                from backend.apps.agents.providers.registry import get_direct_pricing
                                pricing = get_direct_pricing(resolved_model) or get_direct_pricing(session.model)
                                if pricing:
                                    in_rate, out_rate = pricing
                                    cost = (
                                        (inp + cache_create + cache_read) * in_rate
                                        + out * out_rate
                                    ) / 1_000_000
                                else:
                                    # Unknown model in this family: zero out
                                    # rather than ship an Anthropic-rate
                                    # estimate that's wildly wrong.
                                    cost = 0.0

                            session.cost_usd = cost
                            await ws_manager.send_to_session(session_id, "agent:cost_update", {
                                "session_id": session_id,
                                "cost_usd": session.cost_usd,
                            })

                        if isinstance(usage, dict):
                            # Per-turn context-usage broadcast. Drives the UI
                            # status pill and the auto-compact threshold. The
                            # denominator is the session's real model cap,
                            # populated from registry.get_context_window at
                            # session creation, restore, and model-switch
                            # (see apply_context_window). max(1, ...) is a
                            # belt-and-braces guard against zero/None drift
                            # from any future restore-from-disk corner case.
                            _ctx_window = max(1, getattr(session, "context_window", 0) or 200_000)
                            ctx_used_pct = round(total_input / _ctx_window, 4) if total_input else 0.0
                            cache_read_pct = round(cache_read / total_input, 4) if total_input else 0.0
                            try:
                                await ws_manager.send_to_session(session_id, "agent:context_update", {
                                    "session_id": session_id,
                                    "input_tokens": total_input,
                                    "output_tokens": out,
                                    "cache_read_tokens": cache_read,
                                    "cache_read_pct": cache_read_pct,
                                    "ctx_used_pct": ctx_used_pct,
                                    "context_window": _ctx_window,
                                    "framework_overhead_tokens": session.framework_overhead_tokens,
                                    "active_mcps": list(session.active_mcps),
                                })
                            except Exception:
                                logger.exception("Failed to emit agent:context_update")

            capacity_retry_attempt = 0
            while True:
                try:
                    await _run_streaming_turn()
                    break
                except Exception as e:
                    # Make sure the consolidated-thinking ticker doesn't
                    # outlive the turn on error/retry. Without this, an
                    # exception mid-stream leaves a dangling task that
                    # keeps re-emitting against a stale msg id.
                    if thinking.ticker_task is not None and not thinking.ticker_task.done():
                        thinking.ticker_task.cancel()
                        try:
                            await thinking.ticker_task
                        except (asyncio.CancelledError, Exception):
                            pass
                    thinking.ticker_task = None
                    stderr_snapshot = "\n".join(_stderr_buffer[-50:])
                    wait = capacity_retry_wait(e, capacity_retry_attempt, extra_text=stderr_snapshot)
                    if wait is not None:
                        capacity_retry_attempt += 1
                        mid_stream = turn.current_turn_emitted
                        logger.warning(
                            f"Transient upstream error on session {session_id} "
                            f"(attempt {capacity_retry_attempt}/{len(CAPACITY_BACKOFFS)}, "
                            f"mid_stream={mid_stream}); sleeping {wait}s before retry. "
                            f"exc={e!r} stderr_tail={stderr_snapshot[-400:]!r}"
                        )
                        # Finalize any in-flight stream messages so the UI
                        # doesn't leave them pinned as "still streaming" while
                        # we wait and restart. On resume the CLI re-runs the
                        # last turn from scratch (Anthropic doesn't persist
                        # in-progress responses), so the partial assistant
                        # text / tool call we emitted is now orphaned, cap
                        # it with stream_end and start the fresh turn under a
                        # new message id.
                        if turn.stream_text_msg_id:
                            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                                "session_id": session_id,
                                "message_id": turn.stream_text_msg_id,
                            })
                            turn.stream_text_msg_id = None
                        turn.stream_text_accum = ""
                        self._live_partial.pop(session_id, None)
                        for _tool_msg_id in turn.stream_tool_msg_ids_ordered:
                            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                                "session_id": session_id,
                                "message_id": _tool_msg_id,
                            })
                        turn.stream_tool_msg_ids_ordered = []
                        turn.stream_block_index_map = {}
                        turn.current_turn_emitted = False
                        await asyncio.sleep(wait)
                        _stderr_buffer.clear()
                        if session.sdk_session_id:
                            options_kwargs["resume"] = session.sdk_session_id
                            options = ClaudeAgentOptions(**options_kwargs)
                        continue
                    raise

            session.status = "completed"

            # Auto-continuation hook (Phase 3). If MCPActivate (or any
            # analogous flow) flagged pending_continuation during this
            # turn, kick off a follow-up turn immediately with the
            # captured prompt. We dispatch as a fire-and-forget task so
            # the current _run_agent_loop frame can unwind cleanly
            # before the next turn's options + history rebuild kicks in.
            # The follow-up is `hidden=True` so it doesn't add a user
            # bubble to the visible chat; the model sees it as a
            # synthetic prompt to keep working.
            try:
                if getattr(session, "pending_continuation", False):
                    _continuation_prompt = session.pending_continuation_prompt or "Continue."
                    session.pending_continuation = False
                    session.pending_continuation_prompt = None
                    asyncio.create_task(self.send_message(
                        session_id,
                        _continuation_prompt,
                        hidden=True,
                    ))
                    logger.info(f"Auto-continuing session {session_id} with hidden prompt")
            except Exception:
                logger.exception("auto-continuation dispatch failed")
        except asyncio.CancelledError:
            # Only act if we're still the session's live task. A user stop pops
            # this task (stop_agent already finalized status + partial), and a
            # follow-up message may have started a newer turn; either way this
            # dying task must NOT clobber the live status or pop the new turn's
            # in-flight partial mirror.
            if self.tasks.get(session_id) is asyncio.current_task():
                session.status = "stopped"
                # A cancelled turn desyncs the CLI's resume transcript from
                # session.messages (the SDK never recorded the interrupted
                # turn), so force the next turn to rebuild history from
                # session.messages, else resume/follow-ups replay a transcript
                # with no trace of the stopped reply ("nothing to continue").
                session.needs_fresh_session = True
                # Persist whatever streamed before the cancel (edit / branch
                # switch paths; the user-stop path already did this in stop_agent).
                await self._commit_partial_now(session)
            turn.stream_text_msg_id = None
            turn.stream_text_accum = ""
        except Exception as e:
            logger.exception(f"Agent {session_id} error: {e}")
            session.status = "error"

            # Long-context-required 429 fork: surface a friendly overflow event
            # so the frontend can render an actionable card ("Switch to Chat
            # mode" / "Start a fresh chat") instead of a raw error blob. The
            # user can't recover by waiting, this is a tier-gate, not a rate
            # limit, so the UX matters.
            try:
                _stderr_tail = "\n".join(_stderr_buffer[-50:])
            except Exception:
                _stderr_tail = ""
            # If we already streamed a substantive assistant response this
            # turn, the user got their answer; the error fired on a
            # subsequent step (title gen, follow-up tool turn, etc.).
            # Don't blast a "context exceeded" card over a completed reply.
            _streamed_substantive = bool(turn.stream_text_msg_id) and turn.current_turn_emitted
            if _streamed_substantive and _is_long_context_error(e, extra_text=_stderr_tail):
                # Mark the session completed (not error), keep the assistant
                # reply visible, and skip the overflow card. The next user
                # turn will properly hit the pre-send guard if the chat is
                # still over cap.
                session.status = "completed"
                if turn.stream_text_msg_id:
                    try:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id,
                            "message_id": turn.stream_text_msg_id,
                        })
                    except Exception:
                        pass
                return
            if _is_long_context_error(e, extra_text=_stderr_tail):
                friendly_msg = (
                    "This conversation has grown too large for your account's "
                    "standard context window. Long-context requests require an "
                    "upgraded tier, switch to Chat mode or start a fresh chat "
                    "to continue."
                )
                error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                _ovf_payload = {
                    "session_id": session_id,
                    "reason": "long_context_required",
                    "message": friendly_msg,
                    "model": session.model,
                    "provider": session.provider,
                    "context_window": session.context_window,
                    "framework_overhead_tokens": session.framework_overhead_tokens,
                    "input_tokens": session.tokens.get("input", 0),
                    "active_mcps": list(session.active_mcps),
                    "compact_threshold_pct": session.compact_threshold_pct,
                    "context_soft_cap_pct": session.context_soft_cap_pct,
                }
                await ws_manager.send_to_session(session_id, "agent:context_overflow", _ovf_payload)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
                try:
                    from backend.apps.service.client import submit_diagnostic
                    submit_diagnostic({
                        "kind": "context_overflow",
                        "where": "agent_manager._run_streaming_turn",
                        "session_id": session_id,
                        "model": session.model,
                        "provider": session.provider,
                        "context_window": session.context_window,
                        "input_tokens": session.tokens.get("input", 0),
                        "framework_overhead_tokens": session.framework_overhead_tokens,
                        "active_mcps_count": len(session.active_mcps),
                        "messages_count": len(session.messages),
                        "error_preview": redact_for_telemetry(str(e), limit=500),
                    })
                except Exception:
                    logger.debug("submit_diagnostic for context_overflow failed", exc_info=True)
            elif _is_transient_capacity_error(e, extra_text=_stderr_tail):
                # A genuine throttle (429/overload/capacity) that already burned
                # the whole silent-backoff budget (the only way one reaches here).
                # It's a limit, not a failure, so don't append a system-message
                # card; emit a transient signal for the muted pill and mark the
                # turn completed so it doesn't read as an error.
                session.status = "completed"
                if turn.stream_text_msg_id:
                    try:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id,
                            "message_id": turn.stream_text_msg_id,
                        })
                    except Exception:
                        pass
                await ws_manager.send_to_session(session_id, "agent:rate_limited", {
                    "session_id": session_id,
                    "retry_after_s": parse_retry_after(e, _stderr_tail),
                })
            elif _is_free_trial_exhausted(e, extra_text=_stderr_tail):
                # Free runs spent. Flip back to own_key and show a friendly
                # "connect a model" upsell instead of a raw 402.
                try:
                    from backend.apps.subscription.free_trial import clear_free_trial
                    await clear_free_trial(load_settings())
                except Exception:
                    logger.debug("clear_free_trial after exhaustion failed", exc_info=True)
                friendly_msg = (
                    "You've used your free runs. Connect a model to keep going: "
                    "your own API key, an AI subscription you already pay for, or "
                    "OpenSwarm Pro."
                )
                error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                await ws_manager.send_to_session(session_id, "agent:free_trial_exhausted", {
                    "session_id": session_id,
                    "message": friendly_msg,
                })
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
            elif _is_auth_error(e, extra_text=_stderr_tail):
                # Three sub-cases the user can hit, with distinct fixes:
                #   1. "No credentials for provider: claude", user picked a
                #      -cc route but doesn't have Claude Pro/Max connected
                #      via 9Router. Tell them to either connect Claude
                #      Pro/Max OR pick a non--cc model.
                #   2. OpenSwarm Pro 401, bearer expired. Reconnect.
                #   3. Anthropic API key 401, wrong key. Re-enter.
                _model = (session.model or "").lower()
                _combined = f"{e!s}\n{_stderr_tail}".lower()
                # Codex/OpenAI subscription tokens rotate every ~2-3
                # minutes, the user sees the rotation window as a 401
                # with "reset after 1m 59s" or similar. Don't ask them to
                # reconnect; just tell them to wait it out and retry.
                if (
                    ("codex/" in _combined or "[codex/" in _combined or _model.startswith(("cx/", "gpt-")))
                    and ("authentication token is expired" in _combined or "authentication token has expired" in _combined or "401" in _combined)
                ):
                    friendly_msg = (
                        "GPT subscription token just rotated, this is "
                        "automatic and resets every couple minutes. Send "
                        "your message again in ~1 minute and it'll go "
                        "through. (No need to reconnect anything.)"
                    )
                    reason = "codex_token_rotating"
                elif "no credentials for provider" in _combined:
                    friendly_msg = (
                        "Selected route requires Claude Pro / Max, but it's "
                        "not connected. Open Settings → Models and either "
                        "connect Claude Pro / Max, or switch the model to a "
                        "non-`-cc` variant (e.g. Claude Sonnet 4.6 instead "
                        "of Sonnet 4.6 -cc)."
                    )
                    reason = "claude_sub_not_connected"
                elif (
                    "-cc" not in _model
                    and getattr(load_settings(), "connection_mode", "own_key") == "openswarm-pro"
                ):
                    friendly_msg = (
                        "OpenSwarm Pro authentication failed. Your subscription "
                        "token may have expired even though the connection still "
                        "shows green. Open Settings → Models and click "
                        "Disconnect / Reconnect on Claude Pro / Max to refresh "
                        "the token."
                    )
                    reason = "openswarm_pro_auth_expired"
                else:
                    friendly_msg = (
                        "Anthropic authentication failed. The API key or "
                        "subscription token for this model is invalid. Open "
                        "Settings → Models and re-enter the API key, or "
                        "reconnect Claude Pro / Max."
                    )
                    reason = "anthropic_auth_invalid"
                error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                await ws_manager.send_to_session(session_id, "agent:auth_error", {
                    "session_id": session_id,
                    "reason": reason,
                    "message": friendly_msg,
                    "model": session.model,
                })
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
            elif _is_unknown_model_error(e, extra_text=_stderr_tail):
                # Upstream rejected the model code itself (e.g. Codex 1211 on a
                # ChatGPT plan that lacks our GPT ids). Track it; the friendly
                # "add an API key / pick another model" card is rendered frontend-side.
                try:
                    from backend.apps.service.client import submit_diagnostic
                    submit_diagnostic({
                        "kind": "model_error",
                        "subkind": "unknown_model",
                        "model": session.model,
                        "provider": session.provider,
                        "connection_mode": getattr(load_settings(), "connection_mode", "own_key"),
                        "error_preview": redact_for_telemetry(str(e), limit=400),
                        "stderr_tail": redact_for_telemetry(_stderr_tail),
                    })
                except Exception:
                    logger.debug("submit_diagnostic model_error failed", exc_info=True)
                error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
            else:
                # Track unclassified agent failures too so we stop flying blind on them.
                try:
                    from backend.apps.service.client import submit_diagnostic
                    submit_diagnostic({
                        "kind": "model_error",
                        "subkind": "unclassified",
                        "model": session.model,
                        "provider": session.provider,
                        "connection_mode": getattr(load_settings(), "connection_mode", "own_key"),
                        "error_preview": redact_for_telemetry(str(e), limit=400),
                        "stderr_tail": redact_for_telemetry(_stderr_tail),
                    })
                except Exception:
                    logger.debug("submit_diagnostic model_error failed", exc_info=True)
                error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
        except BaseException as e:
            # Catch BaseExceptionGroup from anyio task groups (e.g. concurrent
            # CLI crash + pending approval cancellation) so it doesn't escape
            # and kill the uvicorn process.
            logger.exception(f"Agent {session_id} fatal error: {e}")
            session.status = "error"
            error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
            session.messages.append(error_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": error_msg.model_dump(mode="json"),
            })
        finally:
            # Only the session's live task finalizes. A stopped task (popped by
            # stop_agent, which already finalized status + saved) or one
            # superseded by a newer turn must not pop the new turn's partial
            # mirror, broadcast a stale terminal status, or overwrite the
            # snapshot the live turn is writing.
            _is_live_task = self.tasks.get(session_id) is asyncio.current_task()
            if _is_live_task:
                self._live_partial.pop(session_id, None)
            if session_id in self.sessions and _is_live_task:
                # For canvas-launched App Builder sessions, the workspace
                # folder IS the session_id (see launch_agent), so meta.json
                # lives at outputs_workspace/<session_id>/meta.json. Read it
                # and propagate name/description into the Output row before
                # the terminal status fires; without this, the row stays
                # "Untitled App" forever because no React component polls
                # the file on the canvas path. Best-effort, only acts when
                # the row's name is still the default placeholder.
                if session.mode == "view-builder":
                    try:
                        from backend.apps.outputs.outputs import sync_output_from_meta_json, _load_all
                        if sync_output_from_meta_json(session_id, fallback_name=session.name):
                            # Broadcast the renamed row so the sidebar
                            # flips from "Untitled App" to the real name
                            # without waiting for the next mount.
                            try:
                                matching = [o for o in _load_all() if o.workspace_id == session_id]
                                if matching:
                                    await ws_manager.broadcast_global("agent:output_upserted", {
                                        "output": matching[0].model_dump(mode="json"),
                                    })
                            except Exception:
                                logger.exception("post-sync output_upserted broadcast failed")
                    except Exception:
                        logger.exception("post-session meta sync failed")
                await ws_manager.send_to_session(session_id, "agent:status", {
                    "session_id": session_id,
                    "status": session.status,
                    "session": session.model_dump(mode="json"),
                })
                try:
                    _save_session(session_id, session.model_dump(mode="json"))
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
        session.closed_at = datetime.now()
        # Mock branch (claude_agent_sdk missing): leave cost untouched so
        # it stays at its 0.0 default. A fake nonzero value here would
        # poison the cost shown in the session header during dev. The
        # `_mock_run` flag is read by the close path so a mock session
        # doesn't get reported to the cloud as a real one.
        setattr(session, "_mock_run", True)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:cost_update", {
            "session_id": session_id,
            "cost_usd": session.cost_usd,
        })



    async def _commit_partial_now(self, session) -> bool:
        """Persist the in-flight streamed assistant text as a real message and
        push it to the client, idempotently. Lets a stop show the partial
        instantly instead of waiting out the SDK teardown the cancel handler
        sits behind. Returns True if it committed something."""
        live = self._live_partial.pop(session.id, None)
        if not live:
            return False
        text = live.get("text") or ""
        msg_id = live.get("msg_id")
        if not msg_id or not text.strip():
            return False
        if any(getattr(m, "id", None) == msg_id for m in session.messages):
            return False
        partial = Message(
            id=msg_id,
            role="assistant",
            content=text,
            branch_id=live.get("branch_id") or session.active_branch_id,
        )
        upsert_message(session, partial)
        try:
            await ws_manager.send_to_session(session.id, "agent:message", {
                "session_id": session.id,
                "message": partial.model_dump(mode="json"),
            })
            await ws_manager.send_to_session(session.id, "agent:stream_end", {
                "session_id": session.id,
                "message_id": msg_id,
            })
        except Exception:
            pass
        return True

    async def _drain_task(self, task) -> None:
        """Await a cancelled task's (possibly slow) teardown off the hot path."""
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass




    async def generate_title(self, session_id: str, first_prompt: str) -> str:
        return await metadata.generate_title(self.sessions.get(session_id), session_id, first_prompt)

    async def generate_turn_label(self, session_id: str, turn_id: str, user_prompt: str) -> None:
        return await metadata.generate_turn_label(self.sessions.get(session_id), session_id, turn_id, user_prompt)

    async def warm_prompt_cache(self, session_id: str) -> None:
        """Pre-warm Anthropic's prompt cache for a session by firing a
        max_tokens=1 dummy request through the same agent path. Anthropic
        processes the system+tools prefix and writes the cache; the next
        real user turn lands a cache hit instead of paying cold-start.

        Skips silently if the session doesn't exist, isn't on Anthropic,
        or has no Anthropic credentials. Skips if a real request is
        already in flight on this session, Anthropic permits parallel
        requests but it just wastes the warm.
        """
        session = self.sessions.get(session_id)
        if not session:
            return
        # If a real run is in flight, the cache will be warmed by it;
        # firing again is wasted tokens.
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return

        try:
            from backend.apps.agents.providers.registry import _find_builtin_model
            entry = _find_builtin_model(session.model)
            if not entry or entry.get("api") != "anthropic":
                return  # other providers handle caching automatically

            from backend.apps.settings.credentials import get_anthropic_client
            global_settings = load_settings()
            # Free lane rotates pool accounts per call, so a warm ping primes a cache
            # the next call won't hit, and worse it'd burn a metered run at idle (this
            # fires on dashboard mount, not a user query). Skip it on the free trial.
            if getattr(global_settings, "connection_mode", "own_key") == "free-trial":
                return
            client = get_anthropic_client(global_settings)

            # Single ping with the same system + minimal user message.
            # max_tokens=1 keeps it cheap; we don't care about the output.
            await client.messages.create(
                model=entry.get("model_id", session.model),
                max_tokens=1,
                system="You are a helpful assistant. Reply with one character.",
                messages=[{"role": "user", "content": "ping"}],
            )
            logger.debug(f"Cache pre-warm fired for session {session_id}")
        except Exception as e:
            logger.debug(f"Cache pre-warm failed (non-fatal): {e}")

    async def generate_group_meta(self, session_id: str, group_id: str, tool_calls: list[dict], results_summary: list[str] | None = None, is_refinement: bool = False) -> dict:
        return await metadata.generate_group_meta(self.sessions.get(session_id), session_id, group_id, tool_calls, results_summary, is_refinement)


    @staticmethod
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
            apply_context_window(source)

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
                # Sub-agents do NOT inherit parent's attached files. Each
                # parent-message base64-expansion would re-fire in the
                # sub-agent (cost explosion: a 25 MB PDF in parent +
                # 5 InvokeAgent calls = 125 MB transmitted). The
                # sub-agent receives the user's new message only; if it
                # needs the file content, the parent message text from
                # the prior turn already carries the model's summary.
                context_paths=None,
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
        apply_context_window(fork)

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

agent_manager = AgentManager()
