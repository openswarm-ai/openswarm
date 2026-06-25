"""Per-turn SDK options assembly, lifted out of run_agent_loop so agent_manager stays under the
file ceiling. Builds hook_ctx + the gate hooks, the MCP server set + effective tool lists, the
options_kwargs (provider env, preset, thinking, resume/history), runs the pre-send context guard,
and returns the ClaudeAgentOptions plus the bits the streaming turn needs. Mixin method: self.* and
the gate hooks resolve across the MRO unchanged."""

import json
import logging
from typing import Dict, List, Optional, Union
from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import load_all_tools, sanitize_server_name
from backend.apps.agents.tools.web import should_register_web_mcp
from backend.apps.agents.manager.permissions import gate_hooks
from backend.apps.agents.manager.streaming import post_tool_hook as post_tool_hook_mod
from backend.apps.agents.manager.streaming import stop_hook as stop_hook_mod
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.permissions.build_effective_tool_lists import build_effective_tool_lists
from backend.apps.agents.manager.register_builtin_mcp_servers import register_builtin_mcp_servers
from backend.apps.agents.manager.configure_provider_env import configure_provider_env
from backend.apps.agents.manager.session.workspace_git import ensure_cwd_git_repo
from backend.apps.agents.manager.session.history_compaction import build_history_prefix, get_branch_messages
from backend.apps.agents.manager.prompt.compose_turn_system_prompt import compose_turn_system_prompt
from backend.apps.agents.manager.prompt.tool_catalog import get_all_tool_names
from backend.apps.agents.manager.prompt.prompt_context import resolve_mode
from backend.apps.agents.manager.run.run_options_helpers import (
    pre_send_context_guard, set_framework_overhead, register_web_mcp_server,
    append_web_tools_hint, inject_thinking_options,
)

logger = logging.getLogger(__name__)


from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol


class RunOptions(AgentManagerProtocol):
    # No return annotation: the returned tuple carries an SDK ClaudeAgentOptions, which can't be module-imported here (mock-mode would fail to import the manager); it's lazy-imported below.
    @typechecked
    async def build_agent_options(self, session: AgentSession, session_id: str, prompt: str,
                                    prompt_content: Union[str, List], builtin_perms: Dict[str, str],
                                    selected_browser_ids: Optional[List[str]],
                                    selected_app_output_ids: Optional[List[str]],
                                    selected_setting_ids: Optional[List[str]], fork_session: bool,
                                    p_router_model_id: str, p_api_type_for_session: str):
        from claude_agent_sdk import ClaudeAgentOptions
        from claude_agent_sdk.types import HookMatcher

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
            return await post_tool_hook_mod.post_tool_hook(hook_ctx, input_data, tool_use_id, context)
        _, mode_sys_prompt, _ = resolve_mode(session.mode, get_all_tool_names)

        # Reconcile active_mcps against currently-enabled tools (Phase 3). If the user toggled a server off in the Tools page mid-session, drop it from active_mcps automatically so the model isn't told "X is active" while build_mcp_servers silently filters it out. Emit a context_status event so the model and UI both know.
        try:
            p_enabled = {
                sanitize_server_name(t.name)
                for t in load_all_tools()
                if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")
            }
            p_stale = [s for s in session.active_mcps if s not in p_enabled]
            if p_stale:
                session.active_mcps = [s for s in session.active_mcps if s in p_enabled]
                session.needs_fork = True
                await ws_manager.send_to_session(session_id, "agent:context_status", {
                    "session_id": session_id,
                    "reason": "mcp_disabled_externally",
                    "deactivated": p_stale,
                })
                logger.info(f"Reconciled stale active_mcps for session {session_id}: dropped {p_stale}")
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

        set_framework_overhead(session, composed_prompt)

        # Pass session.active_mcps as the activation filter. Empty list ⇒ no MCP tools shipped to the SDK; the model must MCPSearch and MCPActivate first. The product invariant lives here at the dispatch layer (see build_mcp_servers docstring).
        mcp_servers = await self.build_mcp_servers(session.allowed_tools, session.active_mcps)

        browser_delegation_tools, invoke_agent_tools = register_builtin_mcp_servers(
            mcp_servers, session, builtin_perms, selected_browser_ids
        )


        # Register the DDG-backed openswarm-web MCP only when the primary has no reliable native Anthropic web path (decided in tools/web.py); p_m feeds the registration log + provider branch just below, so it stays a loop local.
        p_m = p_router_model_id if isinstance(p_router_model_id, str) else ""
        need_web_mcp = should_register_web_mcp(
            model=session.model,
            router_model_id=p_router_model_id,
            api_type=p_api_type_for_session,
            anthropic_api_key=getattr(global_settings, "anthropic_api_key", None),
            connection_mode=getattr(global_settings, "connection_mode", "own_key"),
        )
        if need_web_mcp:
            register_web_mcp_server(mcp_servers, p_m)

        effective_allowed, effective_disallowed = build_effective_tool_lists(
            session, mcp_servers, builtin_perms, need_web_mcp,
            browser_delegation_tools, invoke_agent_tools,
        )

        composed_prompt = append_web_tools_hint(composed_prompt, need_web_mcp, effective_allowed)

        # Log effective tool lists
        google_allowed = [t for t in effective_allowed if "google-workspace" in t]
        reddit_allowed = [t for t in effective_allowed if "reddit" in t]
        builtin_allowed = [t for t in effective_allowed if not t.startswith("mcp__")]
        logger.info(f"[MCP-DEBUG] effective_allowed: {len(effective_allowed)} total "
                    f"(builtins={len(builtin_allowed)}, google={len(google_allowed)}, reddit={len(reddit_allowed)})")
        if effective_disallowed:
            logger.info(f"[MCP-DEBUG] effective_disallowed: {effective_disallowed}")

        # `p_router_model_id` and `p_api_type_for_session` were resolved at the top of run_agent_loop (before any closures were defined) so analytics closures could tag events with them. Reuse those values here and keep session.provider in sync.
        resolved_model = p_router_model_id
        api_type = p_api_type_for_session
        session.provider = api_type

        # Capture the Claude CLI's stderr into a buffer so the retry classifier can see the real cause of a process crash (e.g. "No pool capacity available" from the OpenSwarm proxy, or the Anthropic SDK's 429/overloaded error body). Without this the SDK's ProcessError only stringifies to "Command failed with exit code 1 / Check stderr output for details", which masks transient capacity issues.
        p_stderr_buffer: List[str] = []

        def p_stderr_cb(line: str) -> None:
            p_stderr_buffer.append(line)
            # Cap the buffer so a runaway subprocess can't balloon RAM.
            if len(p_stderr_buffer) > 500:
                del p_stderr_buffer[:250]

        async def stop_hook(input_data, tool_use_id, context):
            return await stop_hook_mod.stop_hook(hook_ctx, input_data, tool_use_id, context)

        options_kwargs = {
            "model": resolved_model,
            # 64 MB ceiling on the SDK <-> CLI JSON-RPC channel. The default 5 MB blocked any base64'd PDF over ~3.5 MB; we now route PDFs/images as native content blocks, which base64-expand by ~33%. 64 MB clears the largest single Anthropic PDF (32 MB raw) with headroom for prompt + tool results sharing the same frame.
            "max_buffer_size": 64 * 1024 * 1024,
            "permission_mode": "default",
            "can_use_tool": can_use_tool,
            "stderr": p_stderr_cb,
            "hooks": {
                "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
                "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
                "Stop": [HookMatcher(matcher=None, hooks=[stop_hook])],
            },
            "allowed_tools": effective_allowed,
            "disallowed_tools": effective_disallowed,
            "include_partial_messages": True,
        }
        # cc/cx/gc/ag/gemini/openrouter prefixes force 9Router; route="api" bypasses to the provider's host directly; otherwise Pro proxy or key.
        await configure_provider_env(
            options_kwargs, session, resolved_model, api_type, global_settings, []
        )
        if mcp_servers:
            options_kwargs["mcp_servers"] = mcp_servers
            mcp_json_len = len(json.dumps({"mcpServers": mcp_servers}))
            logger.info(f"[MCP-DEBUG] mcp_servers passed to SDK: {list(mcp_servers.keys())}, JSON length={mcp_json_len}")
        # claude_code preset for BOTH system_prompt and tools so the CLI's deferred-tools scaffolding survives. Raw string would replace it.
        options_kwargs["tools"] = {
            "type": "preset",
            "preset": "claude_code",
        }
        # exclude_dynamic_sections=True moves cwd/git/OS grounding out of the cached prefix and into the first user message, unlocks Anthropic prompt cache (~80% input-token cut, 13-31% faster TTFT). Trade-off: grounding freezes at turn 1.
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

        # The claude_code preset auto-attaches the user's claude.ai- connected partner MCPs (`mcp__claude_ai_*`). Those bypass our MCPActivate gate, don't share OAuth state with the OpenSwarm Gmail/Calendar/Drive connectors the user actually configured here, and confuse the model into picking the partner shim instead of our vetted server. Hard-block them at the SDK layer so the model can't even attempt the call.
        options_kwargs["disallowed_tools"] = [
            "mcp__claude_ai_*",
        ]

        if session.cwd:
            # Pre-existing sessions may have workspaces that predate the git-init block in launch_agent, leaving them without a valid HEAD. Ensure it here so subagent worktree-add always works.
            ensure_cwd_git_repo(session.cwd)
            options_kwargs["cwd"] = session.cwd

        inject_thinking_options(options_kwargs, session, prompt, resolved_model, api_type)

        # Fresh-restart path: some session changes must not reuse the CLI's resume transcript. MCPActivate needs a new transport so tool schemas are reread; branch edits/switches need the model to see only get_branch_messages(session), not facts from the old branch's SDK transcript. Soft restart: drop resume + sdk_session_id, replay local history via the prompt, let the SDK build a clean session from the current app state.
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
            history = build_history_prefix(
                get_branch_messages(session),
                cutoff_msg_id=session.compacted_through_msg_id,
            )
            if history:
                if isinstance(prompt_content, str):
                    prompt_content = history + "\n\n" + prompt_content
                elif isinstance(prompt_content, list):
                    prompt_content.insert(0, {"type": "text", "text": history})

        # Compaction trigger (Phase 2). Driven by live ctx_used ratio rather than turn count, fires when input_tokens/context_window crosses session.compact_threshold_pct (default 0.65). Cheap, programmatic summarization (no aux LLM call) so this adds zero latency on the user's turn.
        await pre_send_context_guard(self, session, session_id)

        logger.info(f"[MCP-DEBUG] Creating ClaudeAgentOptions short={session.model} resolved={resolved_model} api_type={api_type}")
        options = ClaudeAgentOptions(**options_kwargs)
        logger.info("[MCP-DEBUG] ClaudeAgentOptions created. Starting query...")
        return options, options_kwargs, prompt_content, p_stderr_buffer, global_settings
