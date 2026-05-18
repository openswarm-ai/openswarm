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

## Instagram (`instagram_dm_mcp` via local install) (optional)

OpenSwarm uses [ShawnMadadha/instagram_dm_mcp](https://github.com/ShawnMadadha/instagram_dm_mcp), a rate-limited fork of trypeggy/instagram_dm_mcp. 25 tools for DMs, user/follower lookup, post engagement, and story reads, powered by `instagrapi` (pure HTTP, no browser). The server enforces per-category rate limits on sends, likes, searches, lookups, and modifications to protect the connected account from being flagged for automation.

### Prerequisites

`git` and `python3` on `PATH`.

### One-time install

From the repo root:

```bash
bash scripts/setup-instagram-mcp.sh
```

This clones the server into `~/.openswarm/instagram-mcp/`, creates a venv, and pip-installs `instagrapi` + the rest of the dependencies. Re-running upgrades to the latest fork commit.

### Connect from the UI

1. Open the **Tools** page in the sidebar.
2. Find the **Instagram** tile and click **Connect Instagram**.
3. Enter the username and password of the Instagram account the agent should use.
4. Tile flips to **Connected**.

Session state is cached at `~/.instagram_dm_mcp/sessions/<username>_session.json` (per OS user, isolated from any project checkout) so future restarts skip the password prompt.

### Rate limits (built into the server)

| Category | Tools | per_min | per_hour | per_day |
|---|---|---:|---:|---:|
| `dm_send` | `send_message`, `send_photo_message`, `send_video_message` | 2 | 20 | 80 |
| `like` | `like_media` | 6 | 30 | 200 |
| `search` | `search_users`, `search_threads` | 30 | 200 | 1000 |
| `lookup` | 16 read tools | 30 | 300 | 2000 |
| `modify` | `mark_message_seen`, `mute_conversation`, `delete_message` | 10 | 100 | 500 |

Plus randomized jitter (1.5–4s before DMs, 0.5–2s before likes, smaller elsewhere) so action timing isn't bot-perfect.

Overridable per env var, e.g.:

```bash
export IG_RATE_LIMIT_DM_SEND_PER_DAY=40
```

Rate-limit state persists at `~/.instagram-mcp-rate-limits.json` so a server restart doesn't reset the daily budget. When a cap is hit, the tool returns a structured `{ok: false, rate_limited: true, retry_after_seconds: ...}` response the agent can surface as *"hit DM cap, retry in 4h"* instead of failing opaquely.

---

## LinkedIn (`linkedin-scraper-mcp` via uvx) (optional)

LinkedIn integration uses [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) (PyPI: `linkedin-scraper-mcp`). Auth is a persistent [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) browser profile, not OAuth and not cookies. This means **one LinkedIn account per host**: the saved profile at `~/.linkedin-mcp/profile/` is shared across every OpenSwarm session on this machine.

### Prerequisite

[`uv`](https://docs.astral.sh/uv/getting-started/installation/) must be on `PATH` (provides the `uvx` runner).

### Connect from the UI (recommended)

1. Open the **Tools** page in the sidebar.
2. Find the **LinkedIn** tile and click **Sign in with LinkedIn**.
3. A Chromium window opens. Complete sign-in (2FA and captcha are supported).
4. The window closes on success; the profile is written to `~/.linkedin-mcp/profile/` and the tile flips to **Connected**.

Behind the scenes, Electron spawns `uvx linkedin-scraper-mcp@latest --login`. No credentials touch OpenSwarm; the MCP server owns the browser session.

### CLI fallback (headless dev, CI, web build)

If you are not using the desktop shell, run the equivalent script from the repo root:

```bash
bash scripts/setup-linkedin-mcp.sh
```

### Sessions and reset

* Sessions can expire. If a tool call fails with an auth error, click **Sign in with LinkedIn** again (or rerun the script).
* To wipe the stored profile (e.g. to switch accounts): click the **Connected** chip in the Tools page, or run `uvx linkedin-scraper-mcp@latest --logout`.

### Tools exposed (17 total)

`get_person_profile`, `get_my_profile`, `connect_with_person`, `get_sidebar_profiles`, `get_inbox`, `get_conversation`, `search_conversations`, `send_message`, `get_company_profile`, `get_company_posts`, `search_companies`, `get_company_employees`, `search_jobs`, `search_people`, `get_job_details`, `get_feed`, `close_session`.

---

## GitHub (`github-mcp-server`) (optional)

The official [github/github-mcp-server](https://github.com/github/github-mcp-server) (Go) ships as a pre-built 6.7 MB single binary. With `--toolsets=all` it exposes **79 tools** covering repos, issues, pull requests, gists, workflows, code search, security, projects, notifications, and more. Auth is a GitHub Personal Access Token passed as `GITHUB_PERSONAL_ACCESS_TOKEN`.

### One-time install

From the repo root:

```bash
bash scripts/setup-github-mcp.sh
```

The script detects your platform (macOS/Linux × x86_64/arm64), downloads the latest release tarball from GitHub Releases, and installs the binary at `~/.openswarm/bin/github-mcp-server`. Re-running it upgrades to the latest version.

### Connect from the UI

1. Create a Personal Access Token at https://github.com/settings/tokens. Fine-grained tokens are recommended; pick the scopes you want the agent to have.
2. Open the **Tools** page in the sidebar.
3. Find the **GitHub** tile and click **Connect GitHub**.
4. Paste the token and confirm. The tile flips to **Connected** and the server is spawned on demand for tool calls.

### Notes

* No background daemon. The binary is spawned by OpenSwarm only when an agent invokes a GitHub tool.
* The token is stored locally in OpenSwarm's tool config and passed as an env var to the binary at spawn time.
* To rotate the token, click the **Connected** chip to disconnect, then reconnect with the new value.
* For read-only mode (safer default for unattended agents), edit the tool's `mcp_config.args` to include `--read-only`.

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
