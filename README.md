# Open Swarm — Agent Orchestrator

A locally-running React + FastAPI application for managing multiple Claude Code instances in parallel. Designed for power users who run multiple agents simultaneously and need a unified interface to monitor, control, and coordinate them.

## Features

- **Multi-agent management** — Launch and monitor multiple Claude Code instances side by side
- **Git worktree isolation** — Each agent works on its own git worktree/branch to avoid conflicts
- **Real-time streaming** — WebSocket-based streaming of agent messages and status updates
- **HITL approvals** — Approve or deny tool usage requests from the dashboard or within each chat
- **Message branching** — Edit prior messages to fork conversations, navigate between branches
- **Prompt template library** — Reusable prompt templates with structured input fields, invoked via `/` commands
- **Skills library** — Manage skills synced to the native `~/.claude/skills/` directory
- **Tools library** — Define custom tool configurations (bash, MCP, Python)
- **Keyboard shortcuts** — Navigate between agents and approve/deny requests without a mouse
- **Diff viewer** — View uncommitted changes in each agent's worktree

## Architecture

```
Frontend (React/TypeScript :3000)     Backend (FastAPI/Python :8324)
┌─────────────────────────────┐      ┌──────────────────────────────┐
│  Dashboard                  │◄────►│  REST API (/api/*)           │
│  Agent Chat (per session)   │      │  WebSocket (/ws/*)           │
│  Templates / Skills / Tools │      │  Agent Manager               │
│  Slash Command Picker       │      │    └─ Claude Agent SDK       │
│  Keyboard Shortcuts         │      │  Worktree Manager            │
│  Diff Viewer                │      │  Library Storage (JSON/files)│
└─────────────────────────────┘      └──────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- Git
- An Anthropic API key (for real agent usage) — `export ANTHROPIC_API_KEY=...`

### Backend

```bash
bash backend/run/dev.sh
# API runs at http://localhost:8324
# Docs at http://localhost:8324/docs
```

### Frontend

```bash
bash frontend/run/dev.sh
# App runs at http://localhost:3000
```

### Mock Mode

If `claude-agent-sdk` is not installed, the backend runs in **mock mode** — agents simulate tool calls and responses so you can develop and test the UI without an API key.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `d` | Go to Dashboard |
| `t` | Go to Templates |
| `1`–`9` | Open agent by position |
| `Shift+A` | Approve all pending requests |
| `Shift+D` | Deny all pending requests |
| `?` | Show shortcuts help |

## Slash Commands

In the chat input, type `/` to invoke templates and skills:
- `/template-name` — Opens the template's input modal
- `/skill-name` — Inserts the skill content into the message

## Project Structure

```
backend/
  apps/
    agents/        — Agent lifecycle, WebSocket, worktree management
    templates/     — Prompt template CRUD (JSON file storage)
    skills/        — Skills CRUD (synced to ~/.claude/skills/)
    tools_lib/     — Tool definitions CRUD (JSON file storage)
    health/        — Health check endpoint
  config/          — FastAPI app configuration
  data/            — Persistent JSON file storage (sessions, dashboards, settings, templates, tools, etc.)

frontend/
  src/
    app/
      components/  — AppShell, NewAgentModal, SlashCommandPicker, KeyboardShortcutsHelp
      pages/
        Dashboard/ — Agent overview grid with live status
        AgentChat/ — Full chat UI with streaming, HITL, branching, diff viewer
        Templates/ — Template library with editor
        Skills/    — Skills library with editor
        Tools/     — Tools library with editor
    shared/
      state/       — Redux slices (agents, templates, skills, tools)
      ws/          — WebSocket manager
      hooks/       — Custom hooks (keyboard shortcuts)
```
