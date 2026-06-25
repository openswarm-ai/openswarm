"""Per-run support methods for AgentManager: build the gated MCP server set, warm the prompt
cache, stream-emit helpers, commit/drain a stopped turn, context-update broadcast, and the aux
metadata + prompt/attachment delegators. Split into a mixin to keep the manager file under the
size ceiling; self.sessions / self.tasks / self.live_partial resolve across the MRO as before."""

import asyncio
import logging
from typing import Dict, List, Optional, Tuple

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager import context_budget
from backend.apps.agents.manager import metadata
from backend.apps.agents.manager.streaming.upsert_message import upsert_message
from backend.apps.agents.manager.prompt.tool_catalog import (
    get_all_tool_names,
    is_fully_denied,
)
from backend.apps.agents.manager.prompt.attachments import (
    build_dir_tree,
    build_prompt_content,
    resolve_attachments,
    resolve_context_paths,
)
from backend.apps.tools_lib.tools_lib import (
    load_all_tools as load_all_tools,
    sanitize_server_name as sanitize_server_name,
    derive_mcp_config,
    refresh_airtable_token,
    refresh_google_token,
    refresh_hubspot_token,
)
from backend.apps.agents.manager.AgentManagerProtocol import AgentManagerProtocol

logger = logging.getLogger(__name__)


class RunSupport(AgentManagerProtocol):
    @typechecked
    async def build_mcp_servers(
        self,
        allowed_tools: List[str],
        active_mcps: Optional[List[str]] = None,
    ) -> Dict:
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

            server_name = sanitize_server_name(tool.name)
            if active_set is not None and server_name not in active_set:
                logger.info(f"[MCP-DEBUG] GATED {server_name}: not in session.active_mcps, model must call MCPActivate first")
                continue

            if is_fully_denied(tool):
                logger.info(f"[MCP-DEBUG] SKIPPED {tool.name}: fully denied")
                continue

            if tool.auth_type == "oauth2" and tool.auth_status == "connected":
                if tool.name.lower() in ("discord", "github"):
                    # Discord uses a shared bot token; GitHub OAuth-app tokens don't expire and carry no refresh_token. Nothing to refresh either way.
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

    @typechecked
    def p_build_dir_tree(self, root: str, max_depth: int = 4, prefix: str = "") -> List[str]:
        return build_dir_tree(root, max_depth, prefix)

    @typechecked
    def maybe_compact(self, session: AgentSession, force: bool = False) -> bool:
        return context_budget.maybe_compact(session, force)

    @typechecked
    async def emit_context_update(
        self,
        session_id: str,
        session: AgentSession,
        *,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cache_read_tokens: int = 0,
        cache_read_pct: float = 0.0,
    ) -> None:
        return await context_budget.emit_context_update(
            session_id, session,
            input_tokens=input_tokens, output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens, cache_read_pct=cache_read_pct,
        )

    @typechecked
    def build_prompt_content(self, prompt: str, images: Optional[List] = None, context_paths: Optional[List] = None, forced_tools: Optional[List[str]] = None, attached_skills: Optional[List] = None, api_type: str = "anthropic", model: str = ""):
        return build_prompt_content(prompt, images, context_paths, forced_tools, attached_skills, api_type, model)

    @typechecked
    def resolve_attachments(self, context_paths: Optional[List], api_type: str, model: str) -> Tuple[str, List[dict], List[str]]:
        return resolve_attachments(context_paths, api_type, model)

    @typechecked
    def p_resolve_context_paths(self, context_paths: Optional[List]) -> str:
        return resolve_context_paths(context_paths)

    @typechecked
    async def stream_text(self, session_id: str, msg_id: str, text: str, delay: float = 0.03):
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

    @typechecked
    async def stream_tool_input(self, session_id: str, msg_id: str, tool_name: str, input_json: str, delay: float = 0.02):
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

    @typechecked
    async def commit_partial_now(self, session) -> bool:
        """Persist the in-flight streamed assistant text as a real message and
        push it to the client, idempotently. Lets a stop show the partial
        instantly instead of waiting out the SDK teardown the cancel handler
        sits behind. Returns True if it committed something."""
        live = self.live_partial.pop(session.id, None)
        if not live:
            return False
        text = live.text or ""
        msg_id = live.msg_id
        if not msg_id or not text.strip():
            return False
        if any(getattr(m, "id", None) == msg_id for m in session.messages):
            return False
        partial = Message(
            id=msg_id,
            role="assistant",
            content=text,
            branch_id=live.branch_id or session.active_branch_id,
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

    @typechecked
    async def drain_task(self, task) -> None:
        """Await a cancelled task's (possibly slow) teardown off the hot path."""
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    @typechecked
    async def generate_title(self, session_id: str, first_prompt: str) -> str:
        return await metadata.generate_title(self.sessions.get(session_id), session_id, first_prompt)

    @typechecked
    async def generate_turn_label(self, session_id: str, turn_id: str, user_prompt: str) -> None:
        return await metadata.generate_turn_label(self.sessions.get(session_id), session_id, turn_id, user_prompt)

    @typechecked
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
        # If a real run is in flight, the cache will be warmed by it; firing again is wasted tokens.
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return

        try:
            from backend.apps.agents.providers.registry import find_builtin_model as find_builtin_model
            entry = find_builtin_model(session.model)
            if not entry or entry.get("api") != "anthropic":
                return  # other providers handle caching automatically

            from backend.apps.settings.credentials import get_anthropic_client
            global_settings = load_settings()
            # Free lane rotates pool accounts per call, so a warm ping primes a cache the next call won't hit, and worse it'd burn a metered run at idle (this fires on dashboard mount, not a user query). Skip it on the free trial.
            if getattr(global_settings, "connection_mode", "own_key") == "free-trial":
                return
            client = get_anthropic_client(global_settings)

            # Single ping with the same system + minimal user message. max_tokens=1 keeps it cheap; we don't care about the output.
            await client.messages.create(
                model=entry.get("model_id", session.model),
                max_tokens=1,
                system="You are a helpful assistant. Reply with one character.",
                messages=[{"role": "user", "content": "ping"}],
            )
            logger.debug(f"Cache pre-warm fired for session {session_id}")
        except Exception as e:
            logger.debug(f"Cache pre-warm failed (non-fatal): {e}")

    @typechecked
    async def generate_group_meta(self, session_id: str, group_id: str, tool_calls: List[dict], results_summary: Optional[List[str]] = None, is_refinement: bool = False) -> Dict:
        return await metadata.generate_group_meta(self.sessions.get(session_id), session_id, group_id, tool_calls, results_summary, is_refinement)
