# Getting Started

A step-by-step guide to get Open Swarm running locally — from clone to launch.

---

## Prerequisites

Make sure the following are installed on your machine before proceeding:

| Tool | Version | Check |
|------|---------|-------|
| **Git** | Any recent | `git --version` |
| **Python** | 3.11+ | `python --version` |
| **Node.js** | 18+ | `node --version` |
| **npm** | 9+ (ships with Node) | `npm --version` |

### Installing prerequisites

<details>
<summary><strong>Node.js (via nvm)</strong></summary>

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
git clone https://github.com/<your-org>/self-swarm.git
cd self-swarm
```

---

## 2. Backend setup (Configure environment variables)

Copy the example environment file and fill in your values:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your values:

```env
# Backend server port
BACKEND_PORT=8324

# Google OAuth (optional — needed for Google Workspace tools)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

---

## 3. Run the application

You have two options: use the provided **run scripts** (recommended) or start each service manually.

### Option A: Run scripts (recommended)

These scripts handle virtual environments, dependency installation, and startup automatically.

**Backend** (starts FastAPI server):

```bash
./backend/run/dev.sh
```

**Frontend** (in a separate terminal):

```bash
./frontend/run/dev.sh
```

### Option B: Manual startup

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
self-swarm/
├── backend/
│   ├── apps/              # FastAPI route modules
│   │   ├── agents/        # Agent lifecycle, WebSocket, worktree management
│   │   ├── templates/     # Prompt template CRUD
│   │   ├── skills/        # Skills CRUD (synced to ~/.claude/skills/)
│   │   ├── tools_lib/     # Tool definitions CRUD
│   │   ├── modes/         # Agent mode configurations
│   │   ├── settings/      # App settings (API keys, preferences)
│   │   ├── outputs/       # Output management
│   │   └── dashboards/    # Dashboard layout persistence
│   ├── config/            # FastAPI app configuration
│   ├── data/              # Persistent JSON file storage
│   ├── run/               # Shell scripts for starting the backend
│   ├── main.py            # FastAPI entrypoint
│   ├── requirements.txt   # Python dependencies
│   └── .env               # Environment variables (not committed)
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/  # AppShell, CommandPicker, modals
│   │   │   └── pages/       # Dashboard, AgentChat, Templates, Skills, Tools, etc.
│   │   └── shared/
│   │       ├── state/       # Redux slices
│   │       ├── ws/          # WebSocket manager
│   │       └── hooks/       # Custom React hooks
│   ├── public/            # Static assets
│   ├── webpack.config.js  # Webpack bundler config
│   └── package.json       # Node dependencies
├── debugger/              # Optional debugging tool
└── README.md
```

---

## Troubleshooting

### Backend won't start — `ModuleNotFoundError`
Make sure you're running from the **project root** (not from `backend/`):
```bash
cd self-swarm
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
