# Contributing

A guide to setting up Open Swarm for local development and contributing to the project.

---

## Prerequisites

Make sure the following are installed on your machine before proceeding:

| Tool | Version | Check |
|------|---------|-------|
| **Git** | Any recent | `git --version` |
| **Python** | 3.11+ | `python --version` |
| **Node.js** | 18+ | `node --version` |
| **npm** | 9+ (ships with Node) | `npm --version` |

<details>
<summary><strong>Installing Node.js via nvm</strong></summary>

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install 22
nvm use 22
```

</details>

---

## 1. Clone the repository

```bash
git clone https://github.com/openswarm-ai/openswarm.git
cd openswarm
```

---

## 2. Configure environment variables

Copy the example environment file:

```bash
cp backend/.env.example backend/.env
```

The Anthropic API key can be set in-app via the **Settings** page — no `.env` entry needed for that.

For other integrations, edit `backend/.env`:

| Variable | Purpose |
|----------|---------|
| `BACKEND_PORT` | Backend server port (default: `8324`) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Workspace integration (Gmail, Calendar, Drive) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace integration |
| `APPLE_ID` | macOS code signing & notarization (release builds only) |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarization (release builds only) |
| `APPLE_TEAM_ID` | macOS code signing (release builds only) |
| `GH_TOKEN` | GitHub Releases publishing (release builds only) |

---

## 3. Run the application

### Option A: All-in-one (recommended)

```bash
bash run/local.sh
```

This starts the backend (port 8324), frontend (port 3000), and Electron shell together. The script handles virtual environments and dependency installation automatically.

### Option B: Run services individually

**Backend** (in one terminal):

```bash
bash backend/run.sh     # API at http://localhost:8324 — docs at /docs
```

**Frontend** (in another terminal):

```bash
bash frontend/run.sh    # App at http://localhost:3000
```

### Option C: Manual startup

**Terminal 1 — Backend server:**

```bash
cd backend
source .venv/bin/activate
cd ..
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8324 --reload --reload-dir backend
```

**Terminal 2 — Frontend dev server:**

```bash
cd frontend
npm run dev
```

---

## 4. Open the app

Once everything is running:

| Service | URL |
|---------|-----|
| **Frontend (UI)** | [http://localhost:3000](http://localhost:3000) |
| **Backend API** | [http://localhost:8324](http://localhost:8324) |
| **API Docs (Swagger)** | [http://localhost:8324/docs](http://localhost:8324/docs) |

---

## Google Workspace integration (optional)

To use Google Calendar, Gmail, Drive, and other Google tools from your agents, you need to set up OAuth credentials. This is a one-time setup.

### a. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. From the left sidebar, go to **APIs & Services → Library**
4. Enable the APIs you want to use:
   - **Google Calendar API**
   - **Gmail API**
   - **Google Drive API**
   - **Google Contacts API** (People API)

### b. Create OAuth credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. If prompted, configure the **OAuth consent screen** first:
   - Choose **External** (or Internal if you're on a Workspace org)
   - Fill in the required app name and email fields
   - Add the scopes you enabled above
   - Add your Google account as a test user (required while the app is in "Testing" status)
4. Back on the credentials page, create an **OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: `http://localhost:8324/api/tools/oauth/callback`
5. Copy the **Client ID** and **Client Secret**

### c. Add credentials to your `.env`

Paste the values into `backend/.env`:

```env
GOOGLE_OAUTH_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
```

### d. Connect from the UI

1. Open the **Tools** page in the sidebar
2. Add or select a Google Workspace tool
3. Click **Connect** — a Google sign-in popup will appear
4. Authorize the requested scopes
5. The popup closes and the tool status changes to **Connected**

Your agents can now use Google Calendar, Gmail, Drive, etc. through MCP tools.

---

## Project structure

```
backend/
  apps/
    agents/           Agent lifecycle, streaming, worktree management
    dashboards/       Dashboard CRUD and layout persistence
    dashboard_layout/ Card positions and spatial canvas state
    templates/        Prompt template CRUD
    skills/           Skills CRUD (synced to ~/.claude/skills/)
    tools_lib/        MCP tool configuration and discovery
    modes/            Agent mode definitions
    outputs/          Views/outputs, vibe coding, Python executor
    settings/         App settings and file browser
    health/           Health check endpoint
    mcp_registry/     MCP server registry proxy
    skill_registry/   Anthropic skills marketplace proxy
  config/             FastAPI app configuration
  data/               Persistent JSON file storage

frontend/
  src/
    app/
      components/     AppShell, Layout, shared UI
      pages/
        Dashboard/    Spatial canvas with agent/view/browser cards
        AgentChat/    Streaming chat, HITL approvals, branching, diff viewer
        Templates/    Template library with structured input fields
        Skills/       Skills library, skill builder, registry browser
        Tools/        Tool config, MCP discovery, OAuth, registry browser
        Modes/        Mode definitions with system prompts
        Views/        Output artifacts, code editor, vibe coding
        Commands/     Keyboard shortcuts reference
        Settings/     App configuration
    shared/
      state/          Redux slices (agents, dashboards, templates, skills, tools, modes, etc.)
      ws/             WebSocket manager
      hooks/          Custom hooks
      styles/         Theme tokens, global styles

electron/
  main.js             Electron main process, auto-updater, Python env management
  scripts/            Build and notarization scripts

run/
  utils/
    build-app.sh        Desktop app packaging (electron-builder)
    build-python-env.sh Standalone Python 3.13 environment bundler
  local.sh           Start backend, frontend, and Electron shell
  publish.sh         Build and deploy to Firebase Hosting
```

---

## Contribution workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Submit a pull request

Please open an issue first for larger changes so we can discuss the approach.

---

## Troubleshooting

### Backend won't start — `ModuleNotFoundError`
Make sure you're running from the **project root** (not from `backend/`):
```bash
cd openswarm
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8324 --reload
```

### Frontend proxy errors / API calls failing
The frontend dev server proxies `/api` requests to `http://localhost:8324`. Make sure the backend is running first.

### Mock mode vs real mode
If you see mock responses, either:
- `claude-agent-sdk` is not installed — run `pip install claude-agent-sdk`
- No Anthropic API key is configured — set `ANTHROPIC_API_KEY` env var or configure it in the Settings page

### `playwright install` errors
Playwright requires browser binaries. Run `playwright install` after pip install to download them.
