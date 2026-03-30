# Agent 2: Split Backend God Objects (Phase 1)

## Context

You are cleaning up the OpenSwarm codebase. This is agent 2 of 4. Agent 1 has already completed Phase 0 (foundations), creating these shared utilities that you should USE:

- `backend/apps/common/json_store.py` — Generic `JsonStore[T]` for JSON file CRUD
- `backend/apps/common/model_registry.py` — Single source of truth for model definitions, `resolve_model_id()`, `calculate_cost()`, etc.
- `backend/apps/common/mcp_utils.py` — `parse_sse_json()`, `sanitize_server_name()`
- `backend/apps/common/llm_helpers.py` — `quick_llm_call()`, `quick_llm_json()`, `strip_markdown_fences()`

**Rules:**
- Every file you create or modify must be <250 lines of code
- Keep code DRY — use the Phase 0 utilities
- Do NOT touch `9router/`, `debugger/`, or `frontend/`
- Do NOT touch tests
- Run the app after each major split to verify nothing is broken: `cd backend && python -m backend.main`

---

## Task 1A: Split `agent_manager.py` (2093 lines → ~6 files)

This is the most important task. `backend/apps/agents/agent_manager.py` is a 2093-line god object.

Read it carefully first. The `AgentManager` class has these distinct responsibilities that should be separated:

### New file: `backend/apps/agents/prompt_builder.py` (~200 lines)

Extract these methods from `AgentManager`:
- `_resolve_mode()` 
- `_compose_system_prompt()`
- `_build_connected_tools_context()`
- `_build_outputs_context()`
- `_build_browser_context()`
- `_get_pre_selected_browser_ids()`
- `_resolve_context_paths()`
- `_build_dir_tree()`
- `_resolve_forced_tools()`
- `_resolve_attached_skills()`
- `_build_prompt_content()`

Make these standalone functions (not methods) that take the data they need as parameters. For example:
```python
def compose_system_prompt(
    default_prompt: str | None, mode_prompt: str | None, 
    session_prompt: str | None, connected_tools_ctx: str | None = None,
    outputs_ctx: str | None = None, browser_ctx: str | None = None,
) -> str | None:
```

### New file: `backend/apps/agents/mcp_builder.py` (~200 lines)

Extract:
- `_build_mcp_servers()` — builds the mcp_servers dict for ClaudeAgentOptions
- `_get_effective_policy()` — the permission policy resolver (currently a nested function inside `_run_agent_loop`)
- `_get_denied_tool_names()`, `_get_all_known_tool_names()`, `_is_fully_denied()` — the module-level helper functions
- `get_all_tool_names()` — the module-level function
- `FULL_TOOLS` — the constant list
- Logic for building `effective_allowed` and `effective_disallowed` tool lists (currently ~50 lines inside `_run_agent_loop`)
- Logic for adding browser-agent and invoke-agent MCP servers

### New file: `backend/apps/agents/session_store.py` (~200 lines)

Extract session persistence and history. Use `JsonStore` from `backend/apps/common/json_store.py` where possible:
- `_save_session()`, `_load_session_data()`, `_delete_session_file()`, `_load_all_session_data()`
- `get_history()` method
- `_build_search_text()` static method
- `reconcile_on_startup()`
- `persist_all_sessions()`
- `restore_all_sessions()`
- `get_browser_agent_children()`

### Refactor: `backend/apps/agents/agent_loop.py` (replace existing, ~250 lines)

The existing `agent_loop.py` (331 lines) is an older/unused file. Replace it with the extracted `_run_agent_loop` method from `agent_manager.py`.

Extract from `AgentManager`:
- `_run_agent_loop()` — the main SDK query loop (lines 501-1128). This is the biggest single method.
- The hook functions (`pre_tool_hook`, `post_tool_hook`, `can_use_tool`) that are currently nested inside `_run_agent_loop`
- `_run_mock_agent()` — the development mock (lines 1172-1259)
- `_stream_text()` and `_stream_tool_input()` — streaming helpers (lines 1130-1170)
- `_fire_session_completed()` — analytics for completed sessions

Use `quick_llm_call` and `quick_llm_json` from `common/llm_helpers.py` for `generate_title()` and `generate_group_meta()`.

### Slim down: `backend/apps/agents/agent_manager.py` (~250 lines)

What remains in `AgentManager`:
- `__init__()` — holds `self.sessions` dict and `self.tasks` dict
- `launch_agent()`
- `send_message()`
- `stop_agent()`
- `handle_approval()`
- `edit_message()`
- `switch_branch()`
- `generate_title()` — refactor to use `quick_llm_call()`
- `generate_group_meta()` — refactor to use `quick_llm_json()`
- `update_session()`
- `close_session()`
- `delete_session()`
- `resume_session()`
- `duplicate_session()`
- `invoke_agent()`
- `get_all_sessions()`, `get_session()`

Each of these methods becomes a thin coordinator that calls into the extracted modules.

The `agent_manager = AgentManager()` singleton stays at the bottom of this file.

### Important Notes for this split:

- `_run_agent_loop` has deeply nested closures (`can_use_tool`, `pre_tool_hook`, `post_tool_hook`, `prompt_stream`). When extracting to `agent_loop.py`, you'll need to pass the session, ws_manager, and other dependencies as parameters to these functions.
- The `duplicate_session` and `invoke_agent` methods have duplicated message-copying logic (~30 lines each). Extract a shared `_copy_session_messages()` helper into `session_store.py`.
- Keep the `agent_manager` singleton import path unchanged: `from backend.apps.agents.agent_manager import agent_manager` must still work.

---

## Task 1B: Split `tools_lib.py` (1153 lines → 5-6 files)

Convert `backend/apps/tools_lib/` from a single file into a package.

### Step 1: Create the package structure

```
backend/apps/tools_lib/
├── __init__.py          # SubApp instance + backward-compat imports
├── routes.py            # Tool CRUD endpoints (~120 lines)
├── oauth.py             # OAuth start, callback, disconnect, refresh (~200 lines)
├── oauth_providers.py   # OAuthProvider dataclass + OAUTH_PROVIDERS registry (~180 lines)
├── mcp_config.py        # derive_mcp_config, _resolve_command, _augmented_path, _extra_bin_dirs (~180 lines)
├── mcp_discovery.py     # discover_tools endpoint + stdio/HTTP/SSE discovery (~200 lines)
├── classification.py    # _SERVICE_RULES, _categorize_tool, _extract_service (~100 lines)
└── models.py            # Already exists, keep as-is
```

### Step 2: What goes where

**`oauth_providers.py`** — Pure data, no dependencies:
- `OAuthProvider` dataclass (lines 86-107)
- `OAUTH_PROVIDERS` dict (lines 109-239)
- `_resolve_oauth_provider()` helper (lines 242-248)

**`oauth.py`** — OAuth flow logic:
- `_pending_oauth` and `_pending_pkce` state dicts (lines 251-252)
- `oauth_callback()` endpoint (lines 319-435)
- `oauth_start()` endpoint (lines 1062-1098)
- `oauth_disconnect()` endpoint (lines 1036-1059)
- `refresh_oauth_token()` function (lines 1102-1153)
- `refresh_google_token` alias

**`mcp_config.py`** — MCP server config derivation:
- `_extra_bin_dirs()` (lines 486-513)
- `_resolve_command()` (lines 516-539)
- `_augmented_path()` (lines 542-552)
- `derive_mcp_config()` (lines 555-637)

**`mcp_discovery.py`** — MCP tool discovery:
- `_discover_mcp_tools_http()` (lines 790-830)
- `_discover_mcp_tools_sse()` (lines 833-856)
- `_discover_mcp_tools_stdio()` (lines 859-941)
- `discover_tools()` endpoint (lines 944-1033)

**`classification.py`** — Tool categorization (pure data + logic):
- `_READ_PREFIXES`, `_WRITE_PREFIXES` (lines 649-651)
- `_SERVICE_RULES` (lines 653-748)
- `_categorize_tool()` (lines 751-760)
- `_extract_service()` (lines 763-770)

**`routes.py`** — CRUD endpoints:
- `list_builtin_tools()`, `list_tools()`, `get_tool()`, `create_tool()`, `update_tool()`, `delete_tool()` (lines 279-474)
- `load_builtin_permissions()`, `save_builtin_permissions()`, permission endpoints (lines 284-311)
- Use `JsonStore` from `backend/apps/common/json_store.py` for the `_load_all`, `_save`, `_load` functions

**`__init__.py`** — Glue:
- `tools_lib` SubApp instance
- `tools_lib_lifespan` 
- Backward-compatible imports so that `from backend.apps.tools_lib.tools_lib import _load_all, derive_mcp_config, ...` still works. Add a `tools_lib.py` shim file OR add these to `__init__.py`.
- Wire up all routes from the sub-modules

### Critical: Maintain backward compatibility

These imports exist in `agent_manager.py` and must keep working:
```python
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    _sanitize_server_name,
    derive_mcp_config,
    load_builtin_permissions,
    refresh_google_token,
)
```

Keep a `tools_lib.py` file that re-exports from the new package modules, OR update all import sites.

---

## Task 1C: Split `outputs.py` (593 lines → 3 files)

### New file: `backend/apps/outputs/helpers.py` (~80 lines)

Extract:
- `_build_data_injection()` (lines 53-70)
- `_inject_data_into_html()` (lines 73-79)
- `_decode_data_param()` (lines 82-90)
- `_validate_against_schema()` (lines 41-48)
- `_walk_directory()` (lines 136-150)

### New file: `backend/apps/outputs/ai_generation.py` (~200 lines)

Extract:
- `VIBE_CODE_SYSTEM_PROMPT` (lines 334-348)
- `vibe_code()` endpoint (lines 351-419) — refactor to use `quick_llm_json` from `common/llm_helpers.py`
- `AUTO_RUN_SYSTEM_PROMPT` (lines 422-427)
- `auto_run_output()` endpoint (lines 430-480) — refactor to use `quick_llm_call`
- `AUTO_RUN_AGENT_SYSTEM_PROMPT` (lines 525-541)
- `auto_run_agent()` endpoint (lines 544-581)
- `cleanup_auto_run_agent()` endpoint (lines 584-593)
- `_get_anthropic_client()` helper (lines 34-38) — or replace with direct `quick_llm_*` usage
- `_resolve_model()` — replace with `resolve_model_id` from `common/model_registry.py`

### Slim down: `backend/apps/outputs/outputs.py` (~200 lines)

What remains:
- SubApp instance + lifespan
- CRUD endpoints (list, get, create, update, delete)
- Workspace endpoints (read, seed, write file, delete file)
- File serving endpoints (serve_workspace_file, serve_output_file)
- `_load_all`, `_save`, `_load`, `load_output` — replace with `JsonStore`

Wire the ai_generation routes into the outputs router.

---

## Task 1D: Split `browser_agent.py` (632 lines → 3 files)

### New file: `backend/apps/agents/browser/schemas.py` (~100 lines)

Extract:
- `BROWSER_TOOLS_SCHEMA` (lines 30-158)
- `ACTION_MAP` (lines 160-170)
- `SYSTEM_PROMPT` (lines 172-193)
- `MAX_TURNS` constant (line 195)

Replace the local `MODEL_MAP` (lines 24-28) with `resolve_model_id` from `common/model_registry.py`.

### New file: `backend/apps/agents/browser/executor.py` (~120 lines)

Extract:
- `execute_browser_tool()` (lines 198-211)
- `_format_tool_result()` (lines 214-234)
- `_request_browser_approval()` (lines 237-274)

### New file: `backend/apps/agents/browser/runner.py` (~250 lines)

Extract:
- `run_browser_agent()` (lines 277-549)
- `_create_browser_card()` (lines 552-580)
- `run_browser_agents()` (lines 583-632)

Create `backend/apps/agents/browser/__init__.py` that re-exports the public API:
```python
from backend.apps.agents.browser.runner import run_browser_agent, run_browser_agents
```

Update `backend/main.py` line 177 which imports `from backend.apps.agents.browser_agent import run_browser_agents`.

---

## Verification

After all tasks are complete:

1. Verify no file in `backend/` exceeds 250 lines:
   ```bash
   find backend -name '*.py' -not -path '*/__pycache__/*' -not -path '*/test*' | xargs wc -l | sort -rn | head -20
   ```

2. Verify the app starts:
   ```bash
   cd backend && python -c "from backend.main import app; print('App created OK')"
   ```

3. Verify key imports still work:
   ```bash
   python -c "from backend.apps.agents.agent_manager import agent_manager; print('OK')"
   python -c "from backend.apps.tools_lib.tools_lib import _load_all, derive_mcp_config, load_builtin_permissions; print('OK')"
   python -c "from backend.apps.agents.browser_agent import run_browser_agents; print('OK')" 
   python -c "from backend.apps.outputs.outputs import _load_all; print('OK')"
   ```
