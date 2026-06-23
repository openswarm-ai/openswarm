import asyncio
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from uuid import uuid4
from typing import Dict, List, Optional
from typeguard import typechecked

from backend.apps.agents.core.models import (
    AgentConfig, AgentSession, Message, MessageBranch, ApprovalRequest, ToolGroupMeta,
)
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    _save as save_tool,
    _sanitize_server_name as sanitize_server_name,
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
    _NON_TRANSIENT_PATTERNS as NON_TRANSIENT_PATTERNS,
    _TRANSIENT_CAPACITY_PATTERNS as TRANSIENT_CAPACITY_PATTERNS,
    CAPACITY_BACKOFFS,
    capacity_retry_wait,
    _is_auth_error as is_auth_error,
    _is_free_trial_exhausted as is_free_trial_exhausted,
    _is_long_context_error as is_long_context_error,
    _is_transient_capacity_error as is_transient_capacity_error,
    _is_unknown_model_error as is_unknown_model_error,
    parse_retry_after,
    redact_for_telemetry,
)
from backend.apps.agents.manager.session.session_store import (
    _load_session_data as load_session_data,
    _save_session as save_session,
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
from backend.apps.agents.manager.streaming import result_message
from backend.apps.agents.manager.streaming.LivePartial import LivePartial
from backend.apps.agents.manager.streaming.upsert_message import upsert_message
from backend.apps.agents.manager.prompt.system_prompt import compose_turn_system_prompt
from backend.apps.agents.tools.web import should_register_web_mcp
from backend.apps.agents.manager.permissions.effective_tools import build_effective_tool_lists
from backend.apps.agents.manager.builtin_mcp_servers import register_builtin_mcp_servers
from backend.apps.agents.manager.session.SessionLifecycleMixin import SessionLifecycleMixin
from backend.apps.agents.manager.MessagingMixin import MessagingMixin
from backend.apps.agents.manager.AgentLaunchMixin import AgentLaunchMixin
from backend.apps.agents.manager.RunSupportMixin import RunSupportMixin
from backend.apps.agents.manager.permissions import gate_hooks
from backend.apps.agents.manager.session.workspace_git import _detect_git_identity as detect_git_identity, _ensure_cwd_git_repo
from backend.apps.agents.manager.prompt.tool_catalog import (
    FULL_TOOLS,
    get_all_known_tool_names,
    get_denied_tool_names,
    is_fully_denied,
    gated_mcp_server_names,
    get_all_tool_names,
)
from backend.apps.agents.core.aux_llm import _safe_resp_text as safe_resp_text, clean_short_label, aux_max_tokens_for
from backend.apps.agents.manager.session.history_compaction import (
    _build_history_prefix as build_history_prefix,
    _estimate_post_compact_input as estimate_post_compact_input,
    _get_branch_messages as get_branch_messages,
)
from backend.apps.agents.manager.prompt.prompt_context import resolve_mode

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


class AgentManager(SessionLifecycleMixin, MessagingMixin, AgentLaunchMixin, RunSupportMixin):
    @typechecked
    def __init__(self):
        self.sessions: Dict[str, AgentSession] = {}
        self.tasks: Dict[str, asyncio.Task] = {}
        # Live mirror of the in-flight streamed assistant text per session, so a
        # stop can persist the partial reply instantly instead of waiting out the
        # multi-second SDK teardown the cancel handler sits behind.
        self.p_live_partial: Dict[str, LivePartial] = {}




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






    @typechecked
    async def p_run_agent_loop(self, session_id: str, prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, fork_session: bool = False, selected_browser_ids: Optional[List[str]] = None, selected_app_output_ids: Optional[List[str]] = None, selected_setting_ids: Optional[List[str]] = None):
        """Run the Claude Agent SDK query loop for a session."""
        session = self.sessions.get(session_id)
        if not session:
            return
        
        from backend.apps.agents.providers.registry import get_api_type as p_get_api_type
        p_api = p_get_api_type(session.model)
        prompt_content = self.p_build_prompt_content(
            prompt, images, context_paths, forced_tools, attached_skills,
            api_type=p_api, model=session.model,
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
            await self.p_run_mock_agent(session_id, prompt)
            return

        session.status = "running"

        # Resolve the model id now so every closure (approval hook, tool
        # executed handler, etc.) has both the short name and the
        # 9Router-prefixed id available without re-resolving. The short
        # name is what the user sees; the router id is what 9Router
        # reports its per-model counters under.
        from backend.apps.agents.providers.registry import (
            resolve_model_id_for_sdk as p_resolve_model_id_early,
            get_api_type as p_get_api_type_early,
        )
        p_router_model_id = p_resolve_model_id_early(session.model, load_settings())
        p_api_type_for_session = p_get_api_type_early(session.model)

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
            # "X is active" while p_build_mcp_servers silently filters it out.
            # Emit a context_status event so the model and UI both know.
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

            # Per-turn estimate of framework overhead (subtracted from displayed
            # input). Conservative on purpose so honest over-shows beat lies.
            # 16K Claude Code preset, 12K base+deferred tools, ~3K/MCP (real
            # MCP tool definitions range 1-10K depending on server; 3K is a
            # rough median that keeps the meter honest without over-trimming),
            # char/4 of composed prompt.
            p_PRESET_OVERHEAD = 16_000
            p_TOOL_DEFS_OVERHEAD = 12_000
            p_PER_MCP_OVERHEAD = 3_000
            p_composed_tokens = len(composed_prompt or "") // 4
            p_mcp_tokens = len(session.active_mcps) * p_PER_MCP_OVERHEAD
            session.framework_overhead_tokens = (
                p_PRESET_OVERHEAD + p_TOOL_DEFS_OVERHEAD + p_composed_tokens + p_mcp_tokens
            )

            # Pass session.active_mcps as the activation filter. Empty list ⇒
            # no MCP tools shipped to the SDK; the model must MCPSearch and
            # MCPActivate first. The product invariant lives here at the
            # dispatch layer (see p_build_mcp_servers docstring).
            mcp_servers = await self.p_build_mcp_servers(session.allowed_tools, session.active_mcps)

            browser_delegation_tools, invoke_agent_tools = register_builtin_mcp_servers(
                mcp_servers, session, builtin_perms, selected_browser_ids, os.path.dirname(__file__)
            )


            # Register the DDG-backed openswarm-web MCP only when the primary has no reliable
            # native Anthropic web path (decided in tools/web.py); p_m feeds the registration log
            # + provider branch just below, so it stays a loop local.
            p_m = p_router_model_id if isinstance(p_router_model_id, str) else ""
            need_web_mcp = should_register_web_mcp(
                model=session.model,
                router_model_id=p_router_model_id,
                api_type=p_api_type_for_session,
                anthropic_api_key=getattr(global_settings, "anthropic_api_key", None),
                connection_mode=getattr(global_settings, "connection_mode", "own_key"),
            )
            if need_web_mcp:
                web_mcp_server_path = os.path.join(
                    os.path.dirname(__file__), "web_mcp_server.py"
                )
                # Tell the MCP which primary the session is using so it
                # can route to that provider's native search tool.
                if p_m.startswith(("gc/", "gemini/", "ag/")):
                    p_primary_hint = "gemini"
                elif p_m.startswith("cx/"):
                    p_primary_hint = "openai"
                else:
                    p_primary_hint = ""
                from backend.auth import get_auth_token as p_get_auth_token3
                mcp_servers["openswarm-web"] = {
                    "command": sys.executable,
                    "args": [web_mcp_server_path],
                    "env": {
                        "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
                        "OPENSWARM_AUTH_TOKEN": p_get_auth_token3(),
                        "OPENSWARM_PRIMARY_API": p_primary_hint,
                    },
                    "type": "stdio",
                }
                logger.info(
                    f"[MCP-DEBUG] Primary {p_m} has no reliable native web search, "
                    f"registering openswarm-web (DDG search + trafilatura fetch, free)"
                )

            effective_allowed, effective_disallowed = build_effective_tool_lists(
                session, mcp_servers, builtin_perms, need_web_mcp,
                browser_delegation_tools, invoke_agent_tools,
            )

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
            p_web_tools_available = need_web_mcp and (
                "mcp__openswarm-web__WebSearch" in effective_allowed
                or "mcp__openswarm-web__WebFetch" in effective_allowed
            )
            if p_web_tools_available:
                p_hint_lines = ["<web_tools>"]
                p_hint_lines.append(
                    "This session does NOT have the built-in `WebSearch` / "
                    "`WebFetch` tools (they delegate to Anthropic Haiku, which "
                    "isn't reachable on this primary). Use the MCP-backed "
                    "equivalents instead, call them DIRECTLY, no ToolSearch "
                    "step needed:"
                )
                if "mcp__openswarm-web__WebSearch" in effective_allowed:
                    p_hint_lines.append(
                        "- `mcp__openswarm-web__WebSearch(query: str, "
                        "num_results?: int)`, DuckDuckGo search."
                    )
                if "mcp__openswarm-web__WebFetch" in effective_allowed:
                    p_hint_lines.append(
                        "- `mcp__openswarm-web__WebFetch(url: str, prompt?: "
                        "str)`, fetch a URL and return readable text."
                    )
                p_hint_lines.append(
                    "Do not call `ToolSearch(select:WebSearch)`, bare "
                    "`WebSearch` is unavailable on this session and that path "
                    "will return empty matches."
                )
                p_hint_lines.append("</web_tools>")
                p_web_hint = "\n".join(p_hint_lines)
                composed_prompt = (
                    f"{composed_prompt}\n\n{p_web_hint}" if composed_prompt else p_web_hint
                )

            # Log effective tool lists
            google_allowed = [t for t in effective_allowed if "google-workspace" in t]
            reddit_allowed = [t for t in effective_allowed if "reddit" in t]
            builtin_allowed = [t for t in effective_allowed if not t.startswith("mcp__")]
            logger.info(f"[MCP-DEBUG] effective_allowed: {len(effective_allowed)} total "
                        f"(builtins={len(builtin_allowed)}, google={len(google_allowed)}, reddit={len(reddit_allowed)})")
            if effective_disallowed:
                logger.info(f"[MCP-DEBUG] effective_disallowed: {effective_disallowed}")

            # `p_router_model_id` and `p_api_type_for_session` were resolved
            # at the top of p_run_agent_loop (before any closures were
            # defined) so analytics closures could tag events with them.
            # Reuse those values here and keep session.provider in sync.
            resolved_model = p_router_model_id
            api_type = p_api_type_for_session
            session.provider = api_type

            # Capture the Claude CLI's stderr into a buffer so the retry
            # classifier can see the real cause of a process crash (e.g.
            # "No pool capacity available" from the OpenSwarm proxy, or the
            # Anthropic SDK's 429/overloaded error body). Without this the
            # SDK's ProcessError only stringifies to "Command failed with
            # exit code 1 / Check stderr output for details", which masks
            # transient capacity issues.
            p_stderr_buffer: list[str] = []

            def p_stderr_cb(line: str) -> None:
                p_stderr_buffer.append(line)
                # Cap the buffer so a runaway subprocess can't balloon RAM.
                if len(p_stderr_buffer) > 500:
                    del p_stderr_buffer[:250]

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
            # cc/cx/gc/ag/gemini/openrouter prefixes force 9Router; route="api"
            # bypasses to the provider's host directly; otherwise Pro proxy or key.
            from backend.apps.nine_router import is_running as p_9r_running
            from backend.apps.agents.providers.registry import _NINEROUTER_MODEL_PREFIXES as p_NINEROUTER_MODEL_PREFIXES
            resolved_is_9router = isinstance(resolved_model, str) and resolved_model.startswith(p_NINEROUTER_MODEL_PREFIXES)

            from backend.apps.agents.providers.registry import _find_builtin_model as p_find_builtin_model
            p_model_entry = p_find_builtin_model(session.model)
            p_is_pinned_api_route = (
                p_model_entry is not None
                and p_model_entry.get("route") == "api"
            )
            p_api_route_provider = (p_model_entry or {}).get("api") if p_is_pinned_api_route else None

            if p_is_pinned_api_route and p_api_route_provider == "anthropic" and getattr(global_settings, "anthropic_api_key", None):
                options_kwargs["env"] = {
                    "ANTHROPIC_API_KEY": global_settings.anthropic_api_key,
                    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                    # Pin subagent envs so they don't drift back to the proxy.
                    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
                    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4-5",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
                }
                logger.info(f"[MCP-DEBUG] Using direct Anthropic API key (route=api) for {session.model}")
            elif p_is_pinned_api_route and p_api_route_provider == "openai" and getattr(global_settings, "openai_api_key", None):
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
                from backend.auth import get_auth_token as p_get_auth_token_o
                p_passthrough_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/openai-passthrough/v1"
                options_kwargs["env"] = {
                    "OPENAI_API_KEY": global_settings.openai_api_key,
                    "OPENAI_BASE_URL": p_passthrough_url,
                    "ANTHROPIC_API_KEY": p_get_auth_token_o() or "9router",
                    "ANTHROPIC_BASE_URL": "http://localhost:20128",
                }
                logger.info(f"[MCP-DEBUG] Using direct OpenAI API key (route=api) for {session.model} via openai-passthrough")
            elif p_is_pinned_api_route and p_api_route_provider == "custom":
                # User-configured OpenAI-compatible endpoint (Ollama Cloud,
                # Together, local Ollama, etc.). Routes through 9Router's
                # openai-compatible provider node we synced from settings.
                from backend.apps.nine_router import ensure_running as p_9r_ensure_c
                if not p_9r_running():
                    logger.info(f"[MCP-DEBUG] custom provider selected but 9Router not running; waiting for startup")
                    await p_9r_ensure_c()
                    if not p_9r_running():
                        raise ValueError(
                            "9Router could not start. Custom OpenAI-compatible "
                            "providers need 9Router to translate the Anthropic "
                            "protocol, install Node.js and restart the app."
                        )
                from backend.apps.agents.providers.registry import _find_custom_provider_for_value as p_find_custom_provider_for_value
                cp = p_find_custom_provider_for_value(global_settings, session.model)
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
                    from backend.apps.nine_router import normalize_openai_compat_base_url as p_norm_cp_url
                    env["OPENAI_BASE_URL"] = p_norm_cp_url(cp.base_url or "")
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
            elif p_is_pinned_api_route and p_api_route_provider == "gemini" and getattr(global_settings, "google_api_key", None):
                # Routed through the local anthropic-proxy so it can scrub the
                # JSON-Schema fields Gemini's API rejects ($schema, additionalProperties,
                # propertyNames, exclusiveMinimum, nested const) that 9Router 0.3.60 misses.
                from backend.auth import get_auth_token as p_get_auth_token_g
                p_proxy_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
                options_kwargs["env"] = {
                    "GEMINI_API_KEY": global_settings.google_api_key,
                    "GOOGLE_API_KEY": global_settings.google_api_key,
                    "ANTHROPIC_API_KEY": p_get_auth_token_g() or "9router",
                    "ANTHROPIC_BASE_URL": p_proxy_url,
                }
                logger.info(f"[MCP-DEBUG] Using direct Google API key (route=api) for {session.model} via local proxy")
            elif api_type == "openrouter" and getattr(global_settings, "openrouter_api_key", None):
                # OpenRouter primary. The route="openrouter" entry's
                # router_model_id is `openrouter/<vendor>/<model>` so
                # 9Router routes via the apikey connection synced from
                # CLI's WebSearch delegation needs an Anthropic-shaped lane;
                # if the user has no Anthropic key/sub/Pro, fall back to OR's
                # resold Claude so subagents stay on the same OR billing.
                if not p_9r_running():
                    from backend.apps.nine_router import ensure_running as p_9r_ensure
                    logger.info(f"[MCP-DEBUG] OpenRouter selected but 9Router not running; waiting for startup")
                    await p_9r_ensure()
                    if not p_9r_running():
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
            elif p_9r_running():
                # Gemini-bound ids go through the local proxy for schema scrubbing;
                # everything else hits 9Router directly.
                p_is_gemini_bound = (
                    isinstance(resolved_model, str)
                    and resolved_model.startswith(("gemini/", "gc/", "ag/"))
                )
                if p_is_gemini_bound:
                    from backend.auth import get_auth_token as p_get_auth_token_g2
                    p_base_url = f"http://127.0.0.1:{os.environ.get('OPENSWARM_PORT', '8324')}/api/anthropic-proxy"
                    env = {
                        "ANTHROPIC_API_KEY": p_get_auth_token_g2() or "9router",
                        "ANTHROPIC_BASE_URL": p_base_url,
                    }
                else:
                    env = {
                        "ANTHROPIC_API_KEY": "9router",
                        "ANTHROPIC_BASE_URL": "http://localhost:20128",
                    }
                # Pin subagent ids to whichever lane the user has, else CLI's
                # default Haiku 4.5 hits 9Router with no Claude route and 401s.
                try:
                    p_sub_conns = _conns  # reuse list fetched above
                except NameError:
                    p_sub_conns = []
                p_active = {c.get("provider") for c in p_sub_conns
                           if isinstance(c, dict) and c.get("isActive")}
                p_sub_model = None
                p_small_model = None
                if global_settings.anthropic_api_key:
                    p_sub_model = "claude-sonnet-4-6"
                    p_small_model = "claude-haiku-4-5-20251001"
                elif "claude" in p_active or "anthropic" in p_active:
                    p_sub_model = "cc/claude-sonnet-4-6"
                    p_small_model = "cc/claude-haiku-4-5-20251001"
                elif "antigravity" in p_active:
                    p_sub_model = "ag/gemini-3-flash"
                    p_small_model = "ag/gemini-3-flash"
                elif "gemini-cli" in p_active:
                    p_sub_model = "gc/gemini-2.5-flash"
                    p_small_model = "gc/gemini-2.5-flash"
                elif "codex" in p_active:
                    p_sub_model = "cx/gpt-5.4-mini"
                    p_small_model = "cx/gpt-5.4-mini"
                if p_sub_model:
                    env["CLAUDE_CODE_SUBAGENT_MODEL"] = p_sub_model
                if p_small_model:
                    env["ANTHROPIC_SMALL_FAST_MODEL"] = p_small_model
                    env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = p_small_model
                logger.info(
                    f"[MCP-DEBUG] 9Router direct, subagent_model={p_sub_model}, small_fast={p_small_model}"
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
                    from backend.apps.nine_router import ensure_running as p_9r_ensure
                    logger.info(f"[MCP-DEBUG] 9Router not running for non-Anthropic model {session.model}; waiting for startup")
                    await p_9r_ensure()
                    if p_9r_running():
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
                ensure_cwd_git_repo(session.cwd)
                options_kwargs["cwd"] = session.cwd

            try:
                level = getattr(session, "thinking_level", "auto") or "auto"
                # Trivially short prompts ("hi", "thanks") don't benefit from
                # 5-30s of hidden reasoning. Override per-turn only, session
                # setting is untouched so the UI pill keeps reflecting the
                # user's choice.
                p_prompt_len = len((prompt or "").strip())
                if 0 < p_prompt_len < 50 and level != "off":
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
            # to see only get_branch_messages(session), not facts from the
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
                history = build_history_prefix(
                    get_branch_messages(session),
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
                if self.p_maybe_compact(session):
                    new_input = estimate_post_compact_input(session)
                    await ws_manager.send_to_session(session_id, "agent:context_status", {
                        "session_id": session_id,
                        "reason": "compacted",
                        "compacted_through_msg_id": session.compacted_through_msg_id,
                    })
                    await self.p_emit_context_update(
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
                p_est_tokens = session.tokens.get("input", 0)
                p_hard_cap = int(session.context_window * session.context_soft_cap_pct)
                if p_est_tokens >= p_hard_cap:
                    trimmed: list[str] = []
                    while p_est_tokens >= p_hard_cap and len(session.active_mcps) > 1:
                        # Keep at least one MCP active so the model can
                        # finish whatever it was doing; trim from oldest
                        # which is FIFO order in the list.
                        trimmed.append(f"mcp:{session.active_mcps.pop(0)}")
                        p_est_tokens -= 8_000  # rough per-MCP schema cost
                    if trimmed:
                        await ws_manager.send_to_session(session_id, "agent:context_status", {
                            "session_id": session_id,
                            "reason": "trimmed",
                            "trimmed": trimmed,
                            "estimate_after": p_est_tokens,
                        })
                        # Surface a visible system breadcrumb in the chat so
                        # the user (and the model on the next turn) know
                        # which MCPs got dropped. Without this, the model
                        # may keep trying to call a now-missing tool and
                        # the user has no idea why.
                        try:
                            p_names = ", ".join(t.replace("mcp:", "") for t in trimmed)
                            p_trim_msg = Message(
                                role="system",
                                content=(
                                    f"Trimmed {len(trimmed)} app{'s' if len(trimmed) != 1 else ''} from this session to fit "
                                    f"the model's context: {p_names}. Re-activate via MCPSearch + MCPActivate "
                                    "if you still need them."
                                ),
                                branch_id=session.active_branch_id,
                            )
                            session.messages.append(p_trim_msg)
                            await ws_manager.send_to_session(session_id, "agent:message", {
                                "session_id": session_id,
                                "message": p_trim_msg.model_dump(mode="json"),
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

            async def p_run_streaming_turn():
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
                                p_ch_in = 0
                                p_ch_out = 0
                                for p_child in self.sessions.values():
                                    if getattr(p_child, "parent_session_id", None) != session.id:
                                        continue
                                    p_ct = getattr(p_child, "tokens", None)
                                    if not isinstance(p_ct, dict):
                                        continue
                                    p_ch_in += int(p_ct.get("input_fresh", 0) or 0)
                                    p_ch_out += int(p_ct.get("output", 0) or 0)
                                turn.baseline_children_in = p_ch_in
                                turn.baseline_children_out = p_ch_out
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
                                p_route_strips_reasoning_pre = (
                                    isinstance(resolved_model, str)
                                    and resolved_model.startswith(("cx/", "gc/", "ag/", "gemini/"))
                                )
                                if p_route_strips_reasoning_pre:
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
                            message, session, session_id, turn, thinking, self.p_live_partial
                        )

                    elif isinstance(message, AssistantMessage):
                        await assistant_message.handle_assistant_message(
                            message, session, session_id, turn, thinking, self.p_live_partial, self.sessions
                        )
                    elif isinstance(message, ResultMessage):
                        await result_message.handle_result_message(
                            message, session, session_id, turn, thinking, self.sessions,
                            resolved_model, api_type, global_settings,
                        )

            capacity_retry_attempt = 0
            while True:
                try:
                    await p_run_streaming_turn()
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
                    stderr_snapshot = "\n".join(p_stderr_buffer[-50:])
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
                        self.p_live_partial.pop(session_id, None)
                        for p_tool_msg_id in turn.stream_tool_msg_ids_ordered:
                            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                                "session_id": session_id,
                                "message_id": p_tool_msg_id,
                            })
                        turn.stream_tool_msg_ids_ordered = []
                        turn.stream_block_index_map = {}
                        turn.current_turn_emitted = False
                        await asyncio.sleep(wait)
                        p_stderr_buffer.clear()
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
            # the current p_run_agent_loop frame can unwind cleanly
            # before the next turn's options + history rebuild kicks in.
            # The follow-up is `hidden=True` so it doesn't add a user
            # bubble to the visible chat; the model sees it as a
            # synthetic prompt to keep working.
            try:
                if getattr(session, "pending_continuation", False):
                    p_continuation_prompt = session.pending_continuation_prompt or "Continue."
                    session.pending_continuation = False
                    session.pending_continuation_prompt = None
                    asyncio.create_task(self.send_message(
                        session_id,
                        p_continuation_prompt,
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
                await self.p_commit_partial_now(session)
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
                p_stderr_tail = "\n".join(p_stderr_buffer[-50:])
            except Exception:
                p_stderr_tail = ""
            # If we already streamed a substantive assistant response this
            # turn, the user got their answer; the error fired on a
            # subsequent step (title gen, follow-up tool turn, etc.).
            # Don't blast a "context exceeded" card over a completed reply.
            p_streamed_substantive = bool(turn.stream_text_msg_id) and turn.current_turn_emitted
            if p_streamed_substantive and is_long_context_error(e, extra_text=p_stderr_tail):
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
            if is_long_context_error(e, extra_text=p_stderr_tail):
                friendly_msg = (
                    "This conversation has grown too large for your account's "
                    "standard context window. Long-context requests require an "
                    "upgraded tier, switch to Chat mode or start a fresh chat "
                    "to continue."
                )
                error_msg = Message(role="system", content=friendly_msg, branch_id=session.active_branch_id)
                session.messages.append(error_msg)
                p_ovf_payload = {
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
                await ws_manager.send_to_session(session_id, "agent:context_overflow", p_ovf_payload)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": error_msg.model_dump(mode="json"),
                })
                try:
                    from backend.apps.service.client import submit_diagnostic
                    submit_diagnostic({
                        "kind": "context_overflow",
                        "where": "agent_manager.p_run_streaming_turn",
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
            elif is_transient_capacity_error(e, extra_text=p_stderr_tail):
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
                    "retry_after_s": parse_retry_after(e, p_stderr_tail),
                })
            elif is_free_trial_exhausted(e, extra_text=p_stderr_tail):
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
            elif is_auth_error(e, extra_text=p_stderr_tail):
                # Three sub-cases the user can hit, with distinct fixes:
                #   1. "No credentials for provider: claude", user picked a
                #      -cc route but doesn't have Claude Pro/Max connected
                #      via 9Router. Tell them to either connect Claude
                #      Pro/Max OR pick a non--cc model.
                #   2. OpenSwarm Pro 401, bearer expired. Reconnect.
                #   3. Anthropic API key 401, wrong key. Re-enter.
                p_model = (session.model or "").lower()
                p_combined = f"{e!s}\n{p_stderr_tail}".lower()
                # Codex/OpenAI subscription tokens rotate every ~2-3
                # minutes, the user sees the rotation window as a 401
                # with "reset after 1m 59s" or similar. Don't ask them to
                # reconnect; just tell them to wait it out and retry.
                if (
                    ("codex/" in p_combined or "[codex/" in p_combined or p_model.startswith(("cx/", "gpt-")))
                    and ("authentication token is expired" in p_combined or "authentication token has expired" in p_combined or "401" in p_combined)
                ):
                    friendly_msg = (
                        "GPT subscription token just rotated, this is "
                        "automatic and resets every couple minutes. Send "
                        "your message again in ~1 minute and it'll go "
                        "through. (No need to reconnect anything.)"
                    )
                    reason = "codex_token_rotating"
                elif "no credentials for provider" in p_combined:
                    friendly_msg = (
                        "Selected route requires Claude Pro / Max, but it's "
                        "not connected. Open Settings → Models and either "
                        "connect Claude Pro / Max, or switch the model to a "
                        "non-`-cc` variant (e.g. Claude Sonnet 4.6 instead "
                        "of Sonnet 4.6 -cc)."
                    )
                    reason = "claude_sub_not_connected"
                elif (
                    "-cc" not in p_model
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
            elif is_unknown_model_error(e, extra_text=p_stderr_tail):
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
                        "stderr_tail": redact_for_telemetry(p_stderr_tail),
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
                        "stderr_tail": redact_for_telemetry(p_stderr_tail),
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
            p_is_live_task = self.tasks.get(session_id) is asyncio.current_task()
            if p_is_live_task:
                self.p_live_partial.pop(session_id, None)
            if session_id in self.sessions and p_is_live_task:
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
                                matching = [o for o in p_load_all() if o.workspace_id == session_id]
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
                    save_session(session_id, session.model_dump(mode="json"))
                except Exception as e:
                    logger.warning(f"Failed to snapshot session {session_id}: {e}")

















agent_manager = AgentManager()
