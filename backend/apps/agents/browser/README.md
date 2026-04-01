# browser/ — Browser Automation Sub-Agents

This package implements autonomous browser agents that can control browser tabs in the frontend. The main agent can delegate browser tasks (navigate, click, type, screenshot, etc.) and these sub-agents execute them independently.

## Architecture

There are **two layers** of tools here, which is important to understand:

```
┌──────────────────────────────────────────────────────────────────┐
│                        Main Agent (Claude SDK)                   │
│                                                                  │
│  Uses DELEGATION tools (MCP):                                    │
│    CreateBrowserAgent  — spin up a new browser + assign a task   │
│    BrowserAgent        — assign a task to an existing browser    │
│    BrowserAgents       — parallel tasks on multiple browsers     │
│                                                                  │
│  These are defined in browser_agent_mcp_schemas.py               │
│  and served by browser_agent_mcp_server.py (stdio subprocess)    │
└───────────────────────────────────┬──────────────────────────────┘
                                    │ HTTP POST to /browser-agent/run
                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Browser Agent (Anthropic API)                 │
│                                                                  │
│  Uses EXECUTION tools (direct):                                  │
│    BrowserScreenshot   — capture current page                    │
│    BrowserGetText      — get visible text content                │
│    BrowserNavigate     — go to a URL                             │
│    BrowserClick        — click an element by CSS selector        │
│    BrowserType         — type text into an element               │
│    BrowserEvaluate     — run JavaScript on the page              │
│    BrowserGetElements  — query elements by selector              │
│    BrowserScroll       — scroll the page                         │
│    BrowserWait         — wait for a specified duration            │
│                                                                  │
│  These are defined in schemas.py                                 │
│  and executed by executor.py (via WebSocket to frontend)         │
└───────────────────────────────────┬──────────────────────────────┘
                                    │ ws_manager.send_browser_command
                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Frontend Browser Iframe                        │
│                                                                  │
│  Receives WebSocket commands, executes in the actual browser,    │
│  and returns results (screenshots, text, element lists)          │
└──────────────────────────────────────────────────────────────────┘
```

## Files

### `schemas.py` — Browser Tool Definitions + System Prompt

Pure data file with no imports. Defines everything the browser agent needs to operate.

**`BROWSER_TOOLS_SCHEMA`** — List of 9 Anthropic-compatible tool definitions:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `BrowserScreenshot` | (none) | Capture a screenshot of the current page |
| `BrowserGetText` | (none) | Get all visible text content from the page |
| `BrowserNavigate` | `url` | Navigate to a URL |
| `BrowserClick` | `selector` | Click an element by CSS selector |
| `BrowserType` | `selector`, `text` | Type text into an input element |
| `BrowserEvaluate` | `expression` | Execute JavaScript and return the result |
| `BrowserGetElements` | `selector` | Query DOM elements by CSS selector |
| `BrowserScroll` | `direction` (up/down), `amount` (pixels) | Scroll the page |
| `BrowserWait` | `duration` (ms) | Wait for a specified duration |

**`ACTION_MAP`** — Maps tool names to short action strings for the WebSocket protocol:
```
BrowserScreenshot → screenshot    BrowserClick     → click
BrowserGetText    → get_text      BrowserType      → type
BrowserNavigate   → navigate      BrowserEvaluate  → evaluate
BrowserGetElements→ get_elements  BrowserScroll    → scroll
BrowserWait       → wait
```

**`SYSTEM_PROMPT`** — Multi-paragraph instructions for the browser agent, including:
- Always screenshot first to see the current state
- Wait 2-3 seconds after navigation before screenshots
- Use `BrowserGetElements` before clicking to find correct selectors
- Don't get stuck in loops — try alternative approaches
- Provide clear summaries of what was accomplished

**`MAX_TURNS`** — `25` (maximum LLM turns per browser agent run)

---

### `executor.py` — Tool Execution Bridge

Bridges between the browser agent's tool calls and the actual browser in the frontend.

**`execute_browser_tool(tool_name, tool_input, browser_id, tab_id="")`** (async)
1. Looks up the action string from `ACTION_MAP`
2. Sends the command to the frontend via `ws_manager.send_browser_command()`
3. Waits up to 30 seconds for the frontend to return a result
4. Returns the raw result dict

**`_format_tool_result(result, tool_name)`**
- Converts raw browser results into Anthropic content blocks
- Special case for `BrowserScreenshot`: returns an image content block with base64 PNG
- Other tools: returns text content blocks

**`_request_browser_approval(session, tool_name, tool_input)`** (async)
- Wraps the generic `request_approval()` from `execution/approval.py`
- Uses browser-specific defaults: 300s timeout, analytics tracking disabled

---

### `runner.py` — Core Browser Agent Loop

The main engine that runs browser agents. Uses the Anthropic API directly (not the Claude Agent SDK).

**`run_browser_agent(task, browser_id, model, dashboard_id?, tab_id?, pre_selected?, initial_url?, parent_session_id?)`** (async)

Full lifecycle of a single browser agent:

1. **Setup** — Creates an `AgentSession` in `"browser-agent"` mode with the parent session ID
2. **Initial navigation** — If `initial_url` is provided, navigates and takes an initial screenshot
3. **Agent loop** (up to `MAX_TURNS`):
   a. Calls the Anthropic API with the conversation history + browser tools
   b. For each tool call in the response:
      - Checks builtin permissions for approval requirements
      - Requests approval if needed (via `_request_browser_approval`)
      - Executes the tool via `execute_browser_tool`
      - Formats the result and appends to conversation
      - Logs the action for the action log
   c. If no tool calls → agent is done (the response is the summary)
   d. If cancelled → stop early
4. **Completion** — Takes a final screenshot, sets status, emits via WebSocket
5. **Returns** `{session_id, browser_id, summary, action_log, final_screenshot}`

**Error handling:**
- API errors → logged, session status set to `error`
- Cancellation → session status set to `stopped`
- Always emits final status via WebSocket

**`_create_browser_card(dashboard_id, url, parent_session_id?)`** (async)
- Creates a new browser card on the dashboard
- Adds a `BrowserTab` with the given URL
- Positions the card in the layout
- Persists the dashboard and broadcasts `dashboard:browser_card_added`
- Returns the new `browser_id`

**`run_browser_agents(tasks, model, dashboard_id?, pre_selected_browser_ids?, parent_session_id?)`** (async)
- Runs multiple browser agents in parallel via `asyncio.gather`
- For tasks without a `browser_id`: calls `_create_browser_card` first
- For tasks with `pre_selected_browser_ids`: assigns available pre-selected IDs
- Records `browser_agent.batch_completed` analytics
- Returns list of result dicts

---

### `browser_agent_mcp_schemas.py` — MCP Delegation Tool Schemas

Pure data file. Defines the 3 high-level tools the main agent uses to delegate browser work.

| Tool | Parameters | Description |
|------|-----------|-------------|
| `CreateBrowserAgent` | `task`, `initial_url` | Create a new browser card and run a task on it |
| `BrowserAgent` | `browser_id`, `task`, `tab_id?` | Run a task on an existing browser card |
| `BrowserAgents` | `tasks[]` (each with `browser_id?`, `task`, `tab_id?`, `initial_url?`) | Run multiple browser tasks in parallel |

These are the tools listed by the MCP server when the SDK calls `tools/list`.

---

### `browser_agent_mcp_server.py` — Stdio MCP Server

A standalone script launched as a subprocess by the Claude Agent SDK. It implements the JSON-RPC MCP protocol and proxies browser agent requests to the OpenSwarm backend via HTTP.

**Lifecycle:**
1. The Claude Agent SDK starts this process with stdin/stdout pipes
2. It receives `initialize` → responds with server info and capabilities
3. It receives `tools/list` → returns the 3 delegation tools from `browser_agent_mcp_schemas.py`
4. It receives `tools/call` → dispatches to `handle_tool_call`
5. `handle_tool_call` POSTs to `http://127.0.0.1:{port}/api/agents/browser-agent/run`
6. The backend runs the browser agents and returns results
7. Results are formatted into MCP content blocks and returned to the SDK

**Environment variables:**
| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENSWARM_PORT` | `8325` | Backend server port |
| `OPENSWARM_AGENT_MODEL` | `sonnet` | Model for browser agents |
| `OPENSWARM_DASHBOARD_ID` | — | Dashboard to create browser cards on |
| `OPENSWARM_PRE_SELECTED_BROWSER_IDS` | — | Comma-separated pre-selected browser IDs |
| `OPENSWARM_PARENT_SESSION_ID` | — | Parent session for child tracking |

**Screenshot compression:**
- If a screenshot's base64 exceeds 400KB, it's compressed via PIL (if available)
- Resized to max 1024px wide, converted to JPEG at quality 60
- Falls back gracefully if PIL isn't installed

**No direct Python imports from the backend** — communicates purely via HTTP. This isolation is necessary because it runs as a separate subprocess.

---

### `__init__.py` — Package Exports

Re-exports `run_browser_agent` and `run_browser_agents` from `runner.py` for convenient importing:

```python
from backend.apps.agents.browser import run_browser_agent, run_browser_agents
```

## Key Concepts

### Browser Cards

Browser cards are UI elements in the dashboard that contain an embedded browser. Each card has:
- A unique `browser_id`
- One or more `BrowserTab` instances (each with a URL)
- A position in the dashboard layout

Browser agents are always associated with a specific browser card.

### Parent-Child Sessions

When the main agent spawns browser agents, the browser agent sessions are linked to the parent via `parent_session_id`. This enables:
- Querying all browser agents for a given session
- Stopping all children when the parent stops
- Tracking sub-agent costs and analytics

### Two API Paths

There are two ways browser agents get triggered:

1. **Via MCP** (agent-initiated): The main agent calls `CreateBrowserAgent` → MCP server → HTTP → `run_browser_agents` → `runner.py`
2. **Via REST** (user-initiated): Direct POST to `/browser-agent/run` → `run_browser_agents` → `runner.py`

Both paths end up in the same `run_browser_agents` function.

### Tool Approval in Browser Context

Browser agents share the same HITL approval system as the main agent, but with:
- Shorter timeout (300s vs 600s)
- Analytics tracking disabled (to avoid double-counting)
- Permission checks against the same builtin permission policies
