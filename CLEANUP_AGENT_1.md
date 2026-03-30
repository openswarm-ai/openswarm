# Agent 1: Foundations + Hygiene (Phase 0 + Phase 4)

## Context

You are cleaning up the OpenSwarm codebase. This is the first of 4 agents. Your job is to build shared infrastructure that the other agents will depend on, plus minor hygiene fixes.

**Rules:**
- Every file you create or modify must be <250 lines of code
- Keep code DRY
- Do NOT touch the `9router/` or `debugger/` directories
- Do NOT touch tests
- Run the app after your changes to make sure nothing is broken: `cd backend && python -m backend.main`

---

## Task 0A: Create `backend/apps/common/json_store.py`

**Problem:** Every sub-app copy-pastes identical `_load_all()`, `_save()`, `_load()`, `_delete()` functions for JSON-file CRUD. This exists in:

- `backend/apps/tools_lib/tools_lib.py` (lines 255-277)
- `backend/apps/outputs/outputs.py` (lines 103-134)
- `backend/apps/dashboards/dashboards.py` (lines 27-55)
- `backend/apps/agents/agent_manager.py` (lines 33-61)
- `backend/apps/modes/modes.py`
- `backend/apps/templates/templates.py`
- `backend/apps/skills/skills.py`

**What to do:**

1. Create `backend/apps/common/__init__.py` (empty)
2. Create `backend/apps/common/json_store.py` with a generic `JsonStore` class:

```python
class JsonStore(Generic[T]):
    def __init__(self, model_cls: type[T], data_dir: str, id_field: str = "id"):
        ...
    def load_all(self) -> list[T]: ...
    def save(self, item: T) -> None: ...
    def load(self, item_id: str) -> T: ...        # raises HTTPException(404) if not found
    def delete(self, item_id: str) -> None: ...
    def exists(self, item_id: str) -> bool: ...
```

3. Replace the inline `_load_all`, `_save`, `_load`, `_delete` in **all 7 sub-apps** with `JsonStore` instances.
4. For the agents session store, it's slightly different (uses `session_id` not `id`, and has `_load_all_session_data` returning tuples). Create a small subclass or adapter — keep it clean.

**Verify:** All existing imports of `_load_all`, `_save`, `_load` from these modules still work (they're imported in `agent_manager.py`, `outputs.py`, `dashboards.py`, etc). If external code imports them, keep backward-compatible aliases.

---

## Task 0B: Create `backend/apps/common/model_registry.py`

**Problem:** Model name-to-ID mappings are duplicated with inconsistent values:

- `backend/apps/agents/browser_agent.py` lines 24-28: `MODEL_MAP` with `"sonnet": "claude-sonnet-4-6"`
- `backend/apps/outputs/outputs.py` lines 23-27: `MODEL_MAP` with `"sonnet": "claude-sonnet-4-20250514"`
- `backend/apps/agents/providers/registry.py` lines 25-31: `BUILTIN_MODELS` dict
- `backend/apps/agents/providers/registry.py` lines 284-309: `COST_PER_1M_TOKENS` dict

**What to do:**

1. Create `backend/apps/common/model_registry.py` with:

```python
@dataclass
class ModelDef:
    value: str          # short name ("sonnet")
    label: str          # display name ("Claude Sonnet 4.6")
    model_id: str       # API model ID ("claude-sonnet-4-6")
    provider: str       # "Anthropic", "OpenAI", etc.
    api: str            # "anthropic", "openai", "gemini", "openrouter"
    context_window: int
    input_cost_per_1m: float
    output_cost_per_1m: float

ALL_MODELS: list[ModelDef] = [ ... ]  # Single source of truth

def resolve_model_id(short_name: str) -> str: ...
def get_cost_rates(provider: str, model: str) -> tuple[float, float] | None: ...
def calculate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float: ...
def get_context_window(model: str) -> int: ...
def get_builtin_models_by_provider() -> dict[str, list[dict]]: ...
```

2. Use the canonical model IDs from `providers/registry.py` BUILTIN_MODELS (the `model_id` field there is the correct one: `claude-sonnet-4-6`, `claude-opus-4-6`, etc).

3. Delete `MODEL_MAP` from `browser_agent.py` and `outputs.py`, replace with `resolve_model_id()` import.

4. Delete `BUILTIN_MODELS` and `COST_PER_1M_TOKENS` from `providers/registry.py`, replace with imports from `model_registry.py`. Update `get_available_models()`, `calculate_cost()`, `get_context_window()` in `registry.py` to delegate to the new module.

---

## Task 0C: Create `backend/apps/common/mcp_utils.py`

**Problem:** `_parse_sse_json()` is duplicated verbatim in:
- `backend/apps/tools_lib/tools_lib.py` (lines 773-787)
- `backend/apps/agents/mcp_client.py` (lines 234-249)

Also, `_sanitize_server_name()` is defined in `tools_lib.py` (line 481) but imported into `agent_manager.py`.

**What to do:**

1. Create `backend/apps/common/mcp_utils.py` with:
   - `parse_sse_json(text: str) -> dict | None`
   - `sanitize_server_name(name: str) -> str`

2. Update `tools_lib.py` to import from `common.mcp_utils` instead of defining locally. Keep `_sanitize_server_name` as a backward-compatible alias: `_sanitize_server_name = sanitize_server_name`.

3. Update `mcp_client.py` to import `parse_sse_json` from `common.mcp_utils` instead of having its own `_parse_sse_json` static method.

4. Update `agent_manager.py` imports to use `from backend.apps.common.mcp_utils import sanitize_server_name`.

---

## Task 0D: Create `backend/apps/common/llm_helpers.py`

**Problem:** Multiple files independently construct Anthropic clients, call `messages.create`, strip markdown fences from responses, and parse JSON — with identical error handling. This happens in:

- `agent_manager.py` `generate_title()` (lines 1511-1539)
- `agent_manager.py` `generate_group_meta()` (lines 1541-1617)
- `dashboards.py` `generate_name()` (lines 133-190)
- `outputs.py` `vibe_code()` (lines 351-419)
- `outputs.py` `auto_run_output()` (lines 430-480)

**What to do:**

1. Create `backend/apps/common/llm_helpers.py` with:

```python
async def quick_llm_call(
    system: str,
    user_content: str,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 300,
) -> str:
    """Make a simple LLM call and return the text response. Handles client construction."""

async def quick_llm_json(
    system: str,
    user_content: str,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 300,
) -> dict:
    """Make an LLM call expecting JSON. Strips markdown fences, parses JSON."""

def strip_markdown_fences(text: str) -> str:
    """Remove ```json ... ``` or similar fences from LLM output."""
```

2. These should use `get_anthropic_client` from `backend/apps/settings/credentials.py` internally.

3. **Do not** refactor the callers yet — that's Agent 2's job. Just create the helpers so they're available.

---

## Task 4A: Clean Up `modes/models.py`

**Problem:** `backend/apps/modes/models.py` (171 lines) has ~120 lines of `BUILTIN_MODES` data mixed in with Pydantic schema definitions.

**What to do:**

1. Create `backend/apps/modes/builtin.py` and move the `BUILTIN_MODES` list there.
2. `modes/models.py` should only contain `Mode`, `ModeCreate`, `ModeUpdate` Pydantic models.
3. Update `modes/modes.py` to import `BUILTIN_MODES` from `builtin.py` instead of `models.py`.
4. Check for any other files that import `BUILTIN_MODES` from `models.py` and update them.

---

## Task 4B: DRY Up `outputs/models.py` Migration Validators

**Problem:** `backend/apps/outputs/models.py` (197 lines) has `_migrate_flat_fields` copy-pasted across 4 classes: `Output`, `OutputCreate`, `OutputUpdate`, `WorkspaceSeedRequest`.

**What to do:**

1. Extract a shared function at module level:

```python
def _migrate_legacy_files(data: dict, allow_schema_json: bool = False) -> dict:
    """Convert legacy frontend_code/backend_code fields into the files dict."""
    ...
```

2. Have each `@model_validator` call this shared function instead of duplicating the logic.

---

## Task 4C: Remove Dead Code

1. `backend/apps/tools_lib/tools_lib.py` lines 640-646: empty comment section `# OAuth2 flow for Google Workspace (and other OAuth providers)` followed by another empty comment `# MCP tool discovery`. Remove the stale comments.

---

## Verification

After all tasks are complete:

1. `cd /Users/haikdecie/Desktop/openswarm-ai/openswarm/backend`
2. `python -c "from backend.apps.common.json_store import JsonStore; print('OK')"` 
3. `python -c "from backend.apps.common.model_registry import resolve_model_id; print(resolve_model_id('sonnet'))"` 
4. `python -c "from backend.apps.common.mcp_utils import parse_sse_json, sanitize_server_name; print('OK')"`
5. `python -c "from backend.apps.common.llm_helpers import quick_llm_call; print('OK')"`
6. Verify no existing imports are broken by running: `python -c "from backend.main import app; print('OK')"`
