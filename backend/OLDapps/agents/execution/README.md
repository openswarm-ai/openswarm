# execution/ — Agent Runtime Engine

This package contains the runtime core of the agent system: the Claude Agent SDK query loop, prompt assembly, MCP server configuration, SDK hooks, and the human-in-the-loop approval flow.

## How It All Fits Together

```
run_agent_loop()                         ← entry point (called by AgentManager)
  │
  ├─ build_prompt_content()              ← prompt_builder.py
  │    └─ resolve_context_paths()        ← prompt_context.py
  │
  ├─ create_sdk_hooks()                  ← agent_hooks.py
  │    └─ request_approval()             ← approval.py
  │    └─ get_effective_policy()         ← mcp_builder.py
  │
  ├─ build_agent_options()               ← agent_options.py
  │    ├─ resolve_mode()                 ← prompt_builder.py
  │    ├─ compose_system_prompt()        ← prompt_builder.py
  │    ├─ build_connected_tools_context()← prompt_context.py
  │    ├─ build_browser_context()        ← prompt_context.py
  │    └─ build_mcp_servers()            ← mcp_builder.py
  │
  └─ Claude Agent SDK query()            ← streaming loop
       ├─ StreamEvent → ws_manager       (real-time token streaming)
       ├─ AssistantMessage → Messages    (text + tool calls)
       └─ ResultMessage → cost/tokens    (final accounting)
```

## Files

### `agent_loop.py` — Main Query Loop

The top-level entry point for running an agent. Orchestrates everything else.

**`run_agent_loop(sessions, session_id, prompt, ...)`** (async)

1. Builds the user prompt via `build_prompt_content()` — resolves context paths, forced tools, attached skills, and images
2. Creates SDK hooks via `create_sdk_hooks()` — permission checking, tool approval, result formatting
3. Builds the full options dict via `build_agent_options()` — system prompt, MCP servers, tool permissions, API config
4. Creates `ClaudeAgentOptions` and calls `query()` to start the streaming agent loop
5. Iterates the async stream, dispatching to three handlers:

| Event Type | Handler | What It Does |
|------------|---------|--------------|
| `StreamEvent` | `_handle_stream_event()` | Real-time text/tool streaming deltas → WebSocket |
| `AssistantMessage` | `_handle_assistant_message()` | Extracts text + tool_use blocks, creates Messages, emits via WS |
| `ResultMessage` | `_handle_result_message()` | Captures session ID, cost, token usage |

6. On completion: sets status to `completed`, persists session, fires analytics
7. On cancellation: sets status to `stopped`
8. On error: sets status to `error`, creates an error message

---

### `agent_hooks.py` — SDK Hook Factories

Creates the three hook functions the Claude Agent SDK needs for tool execution control.

**`create_sdk_hooks(session, session_id, sessions, builtin_perms, ...)`**

Returns a tuple of `(can_use_tool, pre_tool_hook, post_tool_hook)`:

**`can_use_tool(tool_name, input_data)`**
- Looks up the effective permission policy for the tool
- `always_allow` → auto-approve
- `deny` → auto-reject
- `ask` → triggers HITL approval (except for `AskUserQuestion` which is always allowed)

**`pre_tool_hook(input_data, tool_use_id)`**
- Enforces `deny` policy by returning a denial result
- For `ask` policy, calls `request_approval()` and blocks until user decides
- Tracks tool start time for duration analytics

**`post_tool_hook(input_data, tool_use_id)`**
- Calculates elapsed execution time
- Records `tool.executed` analytics (tool name, MCP server, duration, content length)
- Normalizes response content from the SDK
- Creates `tool_result` Message objects and appends to session
- Special handling for `Agent` tool results — creates sub-agent sessions via `_build_sub_agent_session()`
- Emits everything via WebSocket

**`_build_sub_agent_session(input_data, raw_response, content, session, ...)`**
- Parses the result of an `Agent` tool call
- Creates a child `AgentSession` with the sub-agent's messages
- Stores it in the sessions dict and broadcasts via WebSocket

---

### `agent_options.py` — ClaudeAgentOptions Builder

Assembles the complete configuration dict passed to the Claude Agent SDK.

**`build_agent_options(session, builtin_perms, hooks..., fork_session?, selected_browser_ids?)`** (async)

Builds a kwargs dict containing:

| Key | Source | Description |
|-----|--------|-------------|
| `system_prompt` | `compose_system_prompt()` | Global + mode + session + tool context + browser context |
| `mcp_servers` | `build_mcp_servers()` | User MCP tools (with OAuth2 refresh) |
| + browser MCP | stdio subprocess | `openswarm-browser-agent` (if not fully denied) |
| + invoke MCP | stdio subprocess | `openswarm-invoke-agent` (if not fully denied) |
| `allowed_tools` | `_compute_tool_permissions()` | Tools with `always_allow` or `ask` policy |
| `disallowed_tools` | `_compute_tool_permissions()` | Tools with `deny` policy |
| `model` | `resolve_model_id()` | Resolved from session model + provider |
| `api_key` or proxy | settings | Direct Anthropic key or 9Router proxy URL |
| `session_id` | session | For SDK resume/fork support |

**`_compute_tool_permissions(session, builtin_perms, mcp_servers, ...)`**

Maps permission policies to the SDK's `mcp__<server>__<tool>` naming convention:
- Builtins → direct policy lookup
- Browser/invoke MCP tools → mapped back to their builtin equivalents
- User MCP tools → per-server per-tool permission lookup

Special handling:
- `VIEW_BUILDER_SKILL` is injected when mode is `"view-builder"`
- API key vs. 9Router proxy configuration (with `bare` mode and `cc/` model prefix)
- Resume vs. fork session behavior

---

### `prompt_builder.py` — Prompt Composition

Stateless helpers for building the system prompt and user prompt content.

**`resolve_mode(mode_id, get_all_tool_names_fn)`**
- Loads mode definition (from the modes package)
- Returns `(allowed_tools, system_prompt, default_folder)`
- Falls back to all tools if mode not found

**`compose_system_prompt(default_prompt, mode_prompt, session_prompt, tools_ctx?, browser_ctx?)`**
- Joins non-empty prompt fragments with `\n\n`
- Returns `None` if all fragments are empty

**`resolve_forced_tools(forced_tools, load_all_tools_fn)`**
- Builds XML `<forced_tools>` block describing user-selected tools
- Includes tool descriptions, MCP server names, and connected account emails

**`resolve_attached_skills(attached_skills)`**
- Formats skill attachments as `[Using skill: name]\n\ncontent`

**`build_prompt_content(prompt, images?, context_paths?, forced_tools?, attached_skills?, ...)`**
- Orchestrator that calls all the above
- If images are present: returns a multimodal content list with base64 image blocks
- Otherwise: returns a plain string

---

### `prompt_context.py` — Context Building

Generates XML context blocks that get injected into the system or user prompt.

**`build_connected_tools_context(allowed_tools, ...)`**
- Generates `<connected_mcp_tools>` XML listing all MCP servers, their status, connected accounts, and available tools
- Also lists installed-but-not-connected tools

**`build_browser_context(dashboard_id, selected_browser_ids?)`**
- Generates `<browser_agent_instructions>` XML explaining the browser delegation tools
- Lists user-selected browser cards with IDs, titles, and current URLs

**`get_pre_selected_browser_ids(dashboard_id)`**
- Returns browser card IDs from the dashboard layout

**`resolve_context_paths(context_paths)`**
- For each path: reads file contents (up to 512KB) or builds directory tree (depth 4)
- Wraps in `<context_file>` or `<context_directory>` XML tags

**`build_dir_tree(root, max_depth=4, prefix="")`**
- Recursive directory listing, skipping dotfiles

---

### `mcp_builder.py` — MCP Server Config + Tool Policies

Manages MCP server configuration and resolves tool permission policies.

**Constants:**
- `FULL_TOOLS` — canonical list of ~22 built-in tool names (Read, Edit, Write, Bash, Glob, Grep, AskUserQuestion, WebSearch, WebFetch, NotebookEdit, TodoWrite, EnterPlanMode, ExitPlanMode, EnterWorktree, TaskOutput, TaskStop, CronCreate, CronList, CronDelete, RenderOutput, InvokeAgent, Agent)

**`build_mcp_servers(allowed_tools)`** (async)
- Iterates enabled MCP tools, filters by allowed list
- Skips fully-denied tools
- Refreshes OAuth2 tokens for Google tools
- Derives MCP server configs
- Returns `{server_name: config}` dict

**`get_effective_policy(tool_name, builtin_perms)`**
- Resolves policy for any tool name:
  - Builtins → direct lookup in `builtin_perms`
  - `mcp__openswarm-browser-agent__X` → maps to the builtin browser tool equivalent
  - `mcp__openswarm-invoke-agent__X` → maps to the builtin InvokeAgent equivalent
  - Other MCP tools → per-server per-tool permission lookup
- Default policy: `"ask"`

**`get_all_tool_names()`**
- Returns `FULL_TOOLS` (minus denied builtins) + `mcp:<name>` for enabled/connected MCP tools

Helper functions: `_get_denied_tool_names()`, `_get_all_known_tool_names()`, `_is_fully_denied()`

---

### `approval.py` — Human-in-the-Loop Approval

Shared approval flow used by both the main agent and browser sub-agents.

**`request_approval(session, tool_name, tool_input, timeout?, track_analytics?)`** (async)

1. Creates an `ApprovalRequest` with a unique ID
2. Adds it to the session's `pending_approvals`
3. Sets session status to `waiting_approval`, emits via WebSocket
4. Calls `ws_manager.send_approval_request()` — creates an `asyncio.Future` and waits
5. User's decision resolves the Future (or timeout triggers auto-deny)
6. Records `approval.requested` and `approval.resolved` analytics (with latency)
7. Cleans up, restores status to `running`
8. Returns `{"behavior": "allow"|"deny", "message": ..., "updated_input": ...}`

---

### `agent_mock.py` — Session Completion Analytics

**`fire_session_completed(session, sessions_dict)`**

Fires a comprehensive `session.completed` analytics event with:
- Model, provider, mode
- Total cost (USD), token usage (input + output)
- Message count, duration (seconds)
- Final status, tool usage counts
- Session title, first user message
- Sub-agent count and IDs
- Branch count

---

### `invoke_agent_mcp_server.py` — InvokeAgent MCP Server

A standalone stdio MCP server launched as a subprocess by the Claude Agent SDK.

**How it works:**
1. The SDK starts this as a child process
2. It reads JSON-RPC messages from stdin
3. For `tools/list`: returns the `InvokeAgent` tool schema
4. For `tools/call`: POSTs to `http://127.0.0.1:{port}/api/agents/invoke-agent/run`
5. The backend forks the source session, runs the agent loop, and returns the response
6. The MCP server formats and returns the result

**Environment variables it reads:**
- `OPENSWARM_PORT` — backend port (default 8325)
- `OPENSWARM_PARENT_SESSION_ID` — parent session for tracking
- `OPENSWARM_DASHBOARD_ID` — dashboard context

**No internal Python imports** — communicates with the backend purely via HTTP. This is necessary because it runs as a separate subprocess.
