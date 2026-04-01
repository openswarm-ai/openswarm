# manager/ — Session Management & WebSocket Infrastructure

This package handles the full lifecycle of agent sessions — creating, running, stopping, editing, branching, persisting, restoring, duplicating, and deleting — plus the WebSocket infrastructure that powers real-time communication with the frontend.

## Architecture

```
                    ┌──────────────────────────┐
                    │     agent_manager.py      │  ← singleton facade
                    │       (AgentManager)      │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
   agent_manager_ops.py   agent_manager_meta.py   ws_manager.py
   (edit, close, resume,  (title gen, group meta, (WebSocket connections,
    duplicate, invoke)     persist, restore,       HITL futures,
                           delete)                 browser bridge)
              │                  │
              └────────┬─────────┘
                       ▼
               session_store.py
               (JSON persistence,
                history, search)
```

**Design principle:** `agent_manager.py` is a thin coordinator — it holds the state dicts and delegates all complex logic to sibling modules. This keeps every file under ~250 lines.

## Files

### `agent_manager.py` — Central AgentManager Singleton

The single entry point consumed by all API routes and WebSocket handlers. Holds two core dicts:

- **`sessions: dict[str, AgentSession]`** — all active in-memory sessions
- **`tasks: dict[str, asyncio.Task]`** — running agent loop tasks

**Every method either handles simple logic directly or delegates to a sibling module.**

| Method | Delegates To | Purpose |
|--------|-------------|---------|
| `launch_agent(config)` | — | Creates session, resolves mode/tools, records analytics, emits WS status |
| `send_message(session_id, prompt, ...)` | `run_agent_loop` | Validates session, handles model/mode switching, creates Message, spawns agent loop task |
| `stop_agent(session_id)` | — | Cancels task, resolves approvals, stops browser children, sets status to `stopped` |
| `handle_approval(request_id, decision)` | `ws_manager` | Resolves pending approval Future |
| `edit_message(...)` | `agent_manager_ops` | Triggers branching and re-run |
| `switch_branch(session_id, branch_id)` | — | Sets `active_branch_id`, emits WS event |
| `generate_title(...)` | `agent_manager_meta` | LLM-powered title generation |
| `generate_group_meta(...)` | `agent_manager_meta` | LLM-powered tool group naming + SVG icon |
| `update_session(session_id, **fields)` | — | Updates `system_prompt` or `name`, emits WS status |
| `close_session(session_id)` | `agent_manager_ops` | Stops children, persists, fires analytics |
| `delete_session(session_id)` | `agent_manager_meta` | Permanent deletion from memory and disk |
| `resume_session(session_id)` | `agent_manager_ops` | Loads from disk, restores to memory |
| `duplicate_session(...)` | `agent_manager_ops` | Deep-copies messages and branches |
| `invoke_agent(...)` | `agent_manager_ops` | Forks session, runs agent loop synchronously |
| `get_all_sessions(dashboard_id?)` | — | Filters in-memory sessions |
| `get_session(session_id)` | — | Dict lookup |
| `get_history(...)` | `session_store` | Paginated, filterable session history |
| `reconcile_on_startup()` | `session_store` | Marks stale running sessions as stopped |
| `persist_all_sessions()` | `agent_manager_meta` | Shutdown persistence |
| `restore_all_sessions()` | `agent_manager_meta` | Startup restore |
| `get_browser_agent_children(...)` | `session_store` | Finds child browser sessions |

**Exported as:** `agent_manager = AgentManager()` (module-level singleton)

**Environment:**
- Sets `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` to 1 hour (3,600,000ms)

---

### `agent_manager_ops.py` — Complex Session Operations

Implements operations that involve multiple steps (cancellation, branching, persistence, re-execution).

**`edit_message_op(sessions, tasks, session_id, message_id, new_content)`**
1. Cancels any running agent loop task for the session
2. Creates a new `MessageBranch` forking from the edited message's position
3. Appends a new `Message` with the edited content on the new branch
4. Resets `sdk_session_id` (forces a fresh SDK session)
5. Spawns a new `run_agent_loop` with the edited content
6. Records `session.branched` analytics

**`close_session_op(sessions, tasks, session_id)`**
1. Stops all child browser-agent sessions (has a known circular import workaround)
2. Cancels the running task
3. Resolves any pending approvals with denial
4. Fires `session.completed` analytics
5. Persists the session to disk via `save_session`
6. Removes from in-memory dicts

**`resume_session_op(sessions, session_id)`**
1. Checks if session is already in memory (returns it directly if so)
2. Loads from disk via `load_session_data`
3. Records `session.resumed` analytics (with hours since closed)
4. Clears `closed_at`, sets status back to `stopped`
5. Deletes the on-disk file (session is now in memory)
6. Emits WS status

**`duplicate_session_op(sessions, session_id, dashboard_id?, up_to_message_id?)`**
1. Deep-copies all messages and branches via `copy_session_messages`
2. Creates a new `AgentSession` with `"(copy)"` suffix
3. Emits WS status for the new session

**`invoke_agent_op(sessions, source_session_id, message, parent_session_id?, dashboard_id?)`**
1. Forks the source session (copies messages/branches)
2. Creates a new session in `"invoked-agent"` mode
3. Appends the new user message
4. Runs the agent loop synchronously (awaits completion)
5. Returns the last assistant response text + cost

**Known issue:** `close_session_op` has a circular import from `agent_manager` (flagged with a TODO comment in the code).

---

### `agent_manager_meta.py` — LLM Metadata, Persistence, Deletion

Handles LLM-powered metadata generation and the full persistence lifecycle.

**`generate_title_op(sessions, session_id, first_prompt)`**
- Calls `quick_llm_call` with a prompt asking for a 3-6 word session title
- Falls back to truncating the first prompt on failure
- Emits `agent:name_updated` via WebSocket

**`generate_group_meta_op(sessions, session_id, group_id, tool_calls, ...)`**
- Calls `quick_llm_json` asking for a 2-5 word name and 24x24 SVG icon for a group of tool calls
- Stores result as `ToolGroupMeta` on the session
- Supports refinement (regeneration) via `is_refinement` flag
- Emits `agent:group_meta_updated` via WebSocket

**`persist_all_sessions_op(sessions, tasks)`** — Shutdown hook
1. Iterates all in-memory sessions
2. Stops running sessions, resolves pending approvals
3. Fires `session.completed` analytics for each
4. Serializes to JSON and saves to disk
5. Clears both `sessions` and `tasks` dicts

**`restore_all_sessions_op(sessions)`** — Startup hook
1. Loads all session data from disk
2. Skips closed or corrupt sessions
3. Resets `"running"` status to `"stopped"` (since the agent loop is no longer active)
4. Clears any stale pending approvals
5. Adds to in-memory `sessions` dict
6. Deletes the disk file (session is now managed in memory)

**`delete_session_op(manager, session_id)`**
1. Stops child browser-agent sessions
2. Cancels the running task
3. Removes from in-memory dicts
4. Deletes the on-disk file

---

### `ws_manager.py` — WebSocket ConnectionManager

Manages all WebSocket connections and provides Future-based async bridges for HITL approval and browser commands.

**Zero internal dependencies** — only uses `fastapi.WebSocket` and stdlib. This makes it the lowest-level component in the dependency graph.

#### Connection Management

| Method | Purpose |
|--------|---------|
| `connect_session(session_id, ws)` | Accept and register a per-session WS connection |
| `connect_global(ws)` | Accept and register a dashboard-level WS connection |
| `disconnect_session(session_id, ws)` | Remove a session connection |
| `disconnect_global(ws)` | Remove a global connection |

#### Message Sending

**`send_to_session(session_id, event, data)`**
- Broadcasts to ALL connections for that session AND all global connections
- This ensures dashboard-level listeners always see session updates

**`broadcast_global(event, data)`**
- Sends only to global (dashboard) connections

#### HITL Approval Bridge

**`send_approval_request(session_id, request_id, tool_name, tool_input, timeout=600)`**
- Creates an `asyncio.Future`
- Sends the approval request to the frontend
- Awaits the Future with a 10-minute timeout
- Returns the user's decision (or auto-deny on timeout)

**`resolve_approval(request_id, decision)`**
- Sets the result on the pending Future, unblocking the waiting agent

#### Browser Command Bridge

**`send_browser_command(request_id, action, browser_id, params, tab_id?)`**
- Sends a browser command to the frontend via global WS connections
- Waits up to 30 seconds for the frontend to return a result
- Returns error if no dashboard is connected

**`resolve_browser_command(request_id, result)`**
- Sets the result on the pending Future

#### Typed Event Emitters

14 convenience methods that wrap `send_to_session` with specific event types:

| Emitter | Event Name | Data |
|---------|-----------|------|
| `emit_status` | `agent:status` | Status string + optional full session |
| `emit_message` | `agent:message` | Message object |
| `emit_cost_update` | `agent:cost_update` | Cost in USD |
| `emit_stream_start` | `agent:stream_start` | Message ID, role, optional tool name |
| `emit_stream_delta` | `agent:stream_delta` | Message ID + text delta |
| `emit_stream_end` | `agent:stream_end` | Message ID |
| `emit_branch_created` | `agent:branch_created` | Branch object + active branch ID |
| `emit_branch_switched` | `agent:branch_switched` | Active branch ID |
| `emit_name_updated` | `agent:name_updated` | New session name |
| `emit_group_meta_updated` | `agent:group_meta_updated` | Group ID, name, SVG, is_refined |
| `emit_closed` | `agent:closed` | Full session object |

**Exported as:** `ws_manager = ConnectionManager()` (module-level singleton)

---

### `session_store.py` — On-Disk Persistence & History

Wraps the generic `SessionStore` (from `backend.apps.common.json_store`) with agent-specific logic.

#### Persistence (re-exported from `SessionStore`)

| Name | Purpose |
|------|---------|
| `save_session(id, data)` | Save session JSON to `SESSIONS_DIR/{id}.json` |
| `load_session_data(id)` | Load a session's JSON from disk |
| `delete_session_file(id)` | Delete a session file |
| `load_all_session_data()` | Load all session files from disk |

#### Agent-Specific Functions

**`build_search_text(session, max_len=5000)`**
- Builds a search-indexing string from session name + all user/assistant message text
- Truncated to `max_len` characters
- Used by `get_history` for text search

**`get_history(q?, limit=20, offset=0, dashboard_id?)`**
- Loads all sessions from disk
- Sorts by `closed_at` descending (most recent first)
- Applies text search filter (case-insensitive against `build_search_text`)
- Applies optional `dashboard_id` filter
- Returns `{sessions: [...], total: N, has_more: bool}`

**`reconcile_on_startup()`**
- Iterates all on-disk sessions
- Sets any `"running"` or `"waiting_approval"` status to `"stopped"`
- Handles crashes/restarts gracefully

**`get_browser_agent_children(sessions, parent_session_id)`**
- Finds all browser-agent sessions belonging to a parent
- Checks both in-memory sessions and on-disk data
- Deduplicates by session ID
- Returns list of session summary dicts

**`copy_session_messages(source, up_to_message_id?)`**
- Deep-copies all messages and branches from a source session
- Generates fresh UUIDs for each message
- Re-maps `parent_id` references to new IDs
- Updates branch `fork_point_message_id` to new IDs
- Returns `(new_messages, new_branches, old_to_new_id_map)`
- Used by duplicate and invoke operations

## WebSocket Event Flow

```
Frontend                    ws_manager                     Agent System
   │                            │                              │
   │── connect_session ────────►│                              │
   │                            │                              │
   │                            │◄── emit_status("running") ──│  (agent starts)
   │◄── agent:status ──────────│                              │
   │                            │                              │
   │                            │◄── emit_stream_start ───────│  (LLM streaming)
   │◄── agent:stream_start ────│                              │
   │                            │◄── emit_stream_delta ───────│
   │◄── agent:stream_delta ────│          (repeated)          │
   │                            │◄── emit_stream_end ─────────│
   │◄── agent:stream_end ──────│                              │
   │                            │                              │
   │                            │◄── emit_message ────────────│  (tool call)
   │◄── agent:message ─────────│                              │
   │                            │                              │
   │                            │◄── send_approval_request ───│  (HITL needed)
   │◄── agent:approval_request │                              │
   │                            │         (user decides)       │
   │── approval_response ──────►│                              │
   │                            │── resolve_approval ─────────►│  (unblocks agent)
   │                            │                              │
   │                            │◄── emit_cost_update ────────│  (completion)
   │◄── agent:cost_update ─────│                              │
   │                            │◄── emit_status("completed")─│
   │◄── agent:status ──────────│                              │
```

## Persistence Lifecycle

```
Server Startup:
  reconcile_on_startup()     →  Fix stale "running" statuses on disk
  restore_all_sessions_op()  →  Load disk sessions into memory, delete disk files

During Operation:
  close_session_op()         →  Stop, persist to disk, remove from memory
  resume_session_op()        →  Load from disk to memory, delete disk file

Server Shutdown:
  persist_all_sessions_op()  →  Stop all, save all to disk, clear memory
```

Sessions live in memory while active. They move to disk when closed. They move back to memory when resumed. On server restart, disk sessions are loaded back into memory.
