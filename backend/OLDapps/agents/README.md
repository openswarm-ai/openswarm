# Agents Package

The `agents/` package is the core of OpenSwarm's AI agent system. It manages the full lifecycle of Claude-powered agent sessions — from launching and configuring agents, through real-time streaming conversations, to persistence and history.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Browser)                       │
│   REST API calls ↕           WebSocket events ↕                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  agents.py ─── REST endpoints ──┐                               │
│  ws_routes.py ─ WS dispatch ────┤                               │
│                                 ▼                               │
│                        ┌─────────────────┐                      │
│                        │  AgentManager    │ (singleton facade)   │
│                        │  agent_manager   │                      │
│                        └────────┬────────┘                      │
│                                 │                               │
│              ┌──────────────────┼──────────────────┐            │
│              ▼                  ▼                   ▼            │
│     ┌────────────────┐ ┌──────────────┐  ┌─────────────────┐   │
│     │   manager/     │ │  execution/  │  │    browser/     │   │
│     │                │ │              │  │                 │   │
│     │ Session store  │ │ Agent loop   │  │ Browser agent   │   │
│     │ WS manager     │ │ SDK hooks    │  │ runner + tools  │   │
│     │ Operations     │ │ Prompts      │  │ MCP server      │   │
│     │ Meta/LLM calls │ │ MCP config   │  │                 │   │
│     │ Persistence    │ │ Approval     │  │                 │   │
│     └────────────────┘ └──────────────┘  └─────────────────┘   │
│                                                                 │
│  models.py ─── Shared Pydantic data models                      │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow for a typical user message:**

1. Frontend sends a REST `POST /sessions/{id}/message` or a WebSocket `agent:send_message` event
2. `agents.py` / `ws_routes.py` delegates to `agent_manager.send_message()`
3. `AgentManager` creates a `Message`, emits it via WebSocket, spawns `run_agent_loop()` as an async task
4. `run_agent_loop()` (in `execution/`) builds the prompt, configures MCP servers, creates SDK hooks, then streams the Claude Agent SDK `query()` call
5. Streaming events (text deltas, tool calls, results) are emitted in real-time via `ws_manager`
6. Tool calls go through the permission/approval system (`agent_hooks.py` → `approval.py`)
7. On completion, the session is persisted to disk and analytics are recorded

## Directory Structure

```
agents/
├── README.md                          # This file
├── __init__.py                        # Empty package marker
├── agents.py                          # FastAPI sub-app + all REST endpoints
├── models.py                          # Pydantic models (AgentSession, Message, etc.)
├── ws_routes.py                       # WebSocket event dispatch
│
├── execution/                         # Agent runtime engine
│   ├── README.md                      # Detailed docs for execution/
│   ├── __init__.py
│   ├── agent_loop.py                  # Main Claude SDK query loop + streaming
│   ├── agent_hooks.py                 # SDK permission/lifecycle hook factories
│   ├── agent_options.py               # ClaudeAgentOptions builder
│   ├── agent_mock.py                  # Session-completed analytics
│   ├── approval.py                    # Human-in-the-loop approval flow
│   ├── mcp_builder.py                 # MCP server config + tool policies
│   ├── prompt_builder.py              # Prompt composition helpers
│   ├── prompt_context.py              # Context builders (tools, browser, files)
│   └── invoke_agent_mcp_server.py     # Stdio MCP server for InvokeAgent
│
├── manager/                           # Session management + WebSocket infra
│   ├── README.md                      # Detailed docs for manager/
│   ├── agent_manager.py               # Central AgentManager singleton
│   ├── agent_manager_ops.py           # Complex ops (edit, close, resume, etc.)
│   ├── agent_manager_meta.py          # LLM metadata, persistence, deletion
│   ├── session_store.py               # On-disk JSON persistence + history
│   └── ws_manager.py                  # WebSocket ConnectionManager singleton
│
└── browser/                           # Browser automation sub-agents
    ├── README.md                      # Detailed docs for browser/
    ├── __init__.py                    # Re-exports run_browser_agent(s)
    ├── schemas.py                     # Browser tool definitions + system prompt
    ├── executor.py                    # Tool execution bridge to frontend
    ├── runner.py                      # Core browser agent loop
    ├── browser_agent_mcp_schemas.py   # MCP delegation tool schemas
    └── browser_agent_mcp_server.py    # Stdio MCP server for browser delegation
```

## Top-Level Files

### `agents.py` — REST API Surface

The FastAPI sub-application. Defines ~20 REST endpoints that form the entire HTTP API for agent management. Every endpoint delegates to the `agent_manager` singleton.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/sessions` | List active sessions (optionally by dashboard) |
| GET | `/sessions/{id}` | Get a single session |
| POST | `/launch` | Launch a new agent from an `AgentConfig` |
| POST | `/sessions/{id}/message` | Send a user message (with optional mode/model/images/tools) |
| POST | `/sessions/{id}/stop` | Stop a running agent |
| POST | `/approval` | Handle tool approval decision |
| POST | `/sessions/{id}/edit_message` | Edit a message (triggers branching) |
| POST | `/sessions/{id}/switch_branch` | Switch active conversation branch |
| POST | `/sessions/{id}/generate-title` | AI-generate a session title |
| POST | `/sessions/{id}/generate-group-meta` | AI-generate tool group name + icon |
| PATCH | `/sessions/{id}` | Partial update (name, system prompt) |
| POST | `/sessions/{id}/duplicate` | Deep-copy a session |
| POST | `/sessions/{id}/close` | Close and persist a session |
| DELETE | `/sessions/{id}` | Permanently delete a session |
| GET | `/history` | Search/paginate closed session history |
| GET | `/sessions/{id}/browser-agents` | Get child browser-agent sessions |
| POST | `/sessions/{id}/resume` | Resume a closed session |
| POST | `/browser-agent/run` | Run browser sub-agents |
| POST | `/invoke-agent/run` | Fork and invoke an agent session |

Also defines a **lifespan** context manager that on startup reconciles stale sessions and restores persisted ones, and on shutdown stops all agents and persists state.

### `models.py` — Shared Data Models

Pydantic models used across the entire package:

| Model | Purpose |
|-------|---------|
| `AgentConfig` | Launch configuration (model, mode, tools, system prompt, target directory, dashboard) |
| `AgentSession` | Full session state — status, messages, branches, cost, tokens, approvals, metadata |
| `Message` | Conversation message with role, content, branching info, attachments |
| `MessageBranch` | Branch metadata (parent branch, fork point) |
| `ApprovalRequest` | Pending tool approval sent to user |
| `ApprovalResponse` | User's allow/deny decision |
| `ToolGroupMeta` | AI-generated name + SVG icon for tool call groups |

**Defaults:** Model is `"sonnet"`, provider is `"anthropic"`, mode is `"agent"`, default tools are `[Read, Edit, Write, Bash, Glob, Grep, AskUserQuestion]`.

**Session status flow:**
```
launched → running → completed
                  → stopped (user cancelled)
                  → error
                  → waiting_approval → running (after decision)
```

### `ws_routes.py` — WebSocket Dispatch

Thin event router that handles WebSocket messages from the frontend. Two handlers:

- **`handle_session_message`** — Per-session events: `agent:send_message`, `agent:approval_response`, `agent:edit_message`, `agent:stop`
- **`handle_dashboard_message`** — Dashboard-level events: `agent:approval_response`, `browser:result`

Each event is dispatched to the appropriate `agent_manager` or `ws_manager` method.

## Key Concepts

### Conversation Branching

When a user edits a message, the system creates a new `MessageBranch` forking from the edit point. Messages are linked via `parent_id` and `branch_id`. The active branch can be switched to navigate between conversation paths.

### Human-in-the-Loop (HITL) Approval

Tools can have three permission policies: `always_allow`, `deny`, or `ask`. When a tool with `ask` policy is invoked, the system sends an approval request to the frontend via WebSocket, waits for the user's decision (with a 10-minute timeout), and then allows or denies the tool execution.

### MCP (Model Context Protocol) Servers

The agent system uses MCP servers to extend tool capabilities:
- **User tools** — External MCP servers configured by the user (with OAuth2 support)
- **Browser agent MCP** — Stdio subprocess exposing `CreateBrowserAgent`, `BrowserAgent`, `BrowserAgents`
- **Invoke agent MCP** — Stdio subprocess exposing `InvokeAgent` for cross-session invocation

### Session Persistence

Sessions are persisted as JSON files via `SessionStore`. On shutdown, all active sessions are saved. On startup, persisted sessions are restored to memory and the disk files are removed. Closed sessions remain on disk for history/search.

### Browser Sub-Agents

Browser agents are autonomous agents that control browser tabs in the frontend via a WebSocket bridge. They can screenshot, click, type, scroll, navigate, and evaluate JavaScript. The main agent can delegate browser tasks via MCP tools.

## Dependency Graph

```
agents.py ──────────────────────► agent_manager (singleton)
ws_routes.py ───────────────────► agent_manager, ws_manager

agent_manager
  ├── execution/agent_loop.py    (run_agent_loop)
  ├── execution/prompt_builder.py (resolve_mode)
  ├── execution/mcp_builder.py   (get_all_tool_names)
  ├── manager/ws_manager.py      (emit events)
  ├── manager/session_store.py   (persistence)
  ├── manager/agent_manager_ops.py (edit, close, resume, duplicate, invoke)
  └── manager/agent_manager_meta.py (title gen, group meta, persist/restore)

execution/agent_loop.py
  ├── prompt_builder.py          (build_prompt_content)
  ├── agent_hooks.py             (create_sdk_hooks)
  ├── agent_options.py           (build_agent_options)
  └── Claude Agent SDK           (query, streaming)

browser/runner.py
  ├── browser/executor.py        (execute_browser_tool)
  ├── browser/schemas.py         (tool defs, system prompt)
  ├── Anthropic API              (direct, not SDK)
  └── ws_manager                 (real-time comms)
```

## Design Notes

- **250-line file limit** — Files are deliberately kept under ~250 lines. Complex logic is split across multiple files (e.g., `agent_manager.py` delegates to `agent_manager_ops.py` and `agent_manager_meta.py`).
- **Singleton pattern** — `agent_manager` and `ws_manager` are module-level singletons, imported directly by consumers.
- **Stateless functions** — Most logic is in standalone functions that receive data as parameters rather than relying on class state, making testing easier.
- **Separation of concerns** — Prompt building, MCP configuration, hook creation, and the query loop are each in their own module within `execution/`.
- **Two browser tool layers** — `browser/schemas.py` defines the low-level tools the browser agent uses internally (Screenshot, Click, etc.), while `browser_agent_mcp_schemas.py` defines the high-level delegation tools the main agent uses to spawn browser agents.

## External Dependencies

| Dependency | Used For |
|------------|----------|
| `claude_agent_sdk` | Agent query loop, streaming, tool hooks |
| Anthropic API | Browser agent loop (direct API calls) |
| FastAPI | REST endpoints, WebSocket handling |
| Pydantic | Data models and validation |
| PIL (optional) | Screenshot compression in browser MCP server |

See the sub-package READMEs for detailed per-file documentation:
- [execution/README.md](execution/README.md) — Agent runtime engine
- [manager/README.md](manager/README.md) — Session management and WebSocket infrastructure
- [browser/README.md](browser/README.md) — Browser automation sub-agents
