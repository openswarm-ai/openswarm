# App Builder — Platform Reference

You are building an **App** inside OpenSwarm. The workspace you're working
in is a **React 18 + TypeScript + Vite** project (with an optional FastAPI
backend you can opt into on demand). It's served live to a webview, so it
behaves like a real browser tab — cross-origin `fetch`, popups, mic/camera,
clipboard, anything a normal web page does.

You are **NOT** writing a single HTML file or vanilla JS. Match the
codebase's patterns.

---

## Workspace layout

```
workspace/
├── .env                   # FRONTEND_PORT, BACKEND_PORT (NONE by default)
├── .env.example           # Mirror of .env (LLM-consistency — edit both
│                          #   when you change either)
├── run.sh                 # OpenSwarm's runtime spawns this; you don't
├── backend_init.sh        # Run this when you need a backend (see below)
├── SKILL.md               # This document
└── frontend/
    ├── package.json       # React 18, MUI v7, Redux Toolkit, Framer
    │                      #   Motion, react-router v7
    ├── vite.config.ts     # Vite config — DO NOT edit unless you know why
    ├── tsconfig.json      # `@/*` → `src/*` path alias
    ├── index.html
    └── src/
        ├── index.tsx              # ReactDOM entry; mounts <Main />
        ├── app/
        │   ├── Main.tsx           # Redux + Theme + BrowserRouter + AppShell
        │   └── components/
        │       └── Layout/
        │           ├── AppShell.tsx   # Sidebar + scrollable content
        │           └── Sidebar.tsx    # Nav, theme toggle
        ├── pages/                 # FILE-BASED ROUTING — see below
        │   ├── index.tsx          # /
        │   └── health.tsx         # /health
        └── shared/
            ├── hooks.ts                 # useAppDispatch, useAppSelector
            ├── state/
            │   ├── store.ts             # Redux store config
            │   ├── tempStateSlice.ts    # Sample slice — replace or extend
            │   └── API_ENDPOINTS.ts     # ALL backend URL constants
            └── styles/
                └── ThemeContext.tsx     # Design tokens — USE THESE
```

If a backend is enabled (after `bash backend_init.sh`), you'll also have:

```
└── backend/
    ├── pyproject.toml         # FastAPI + typeguard (+ swarm_debug)
    ├── main.py                # FastAPI app entry — registers SubApps
    ├── apps/                  # Each feature is a SubApp
    │   └── health/
    │       └── health.py      # GET /api/health/check
    └── config/Apps.py         # SubApp / MainApp plugin framework
```

---

## File-based routing

`vite-plugin-pages` auto-registers every `.tsx` file under `frontend/src/pages/`
as a route. **You don't touch any router config.** Just create the file.

- `src/pages/index.tsx`           → `/`
- `src/pages/about.tsx`           → `/about`
- `src/pages/users/index.tsx`     → `/users`
- `src/pages/users/[id].tsx`      → `/users/:id` (dynamic segment)
- `src/pages/users/$id.tsx`       → `/users/:id` (alternate dynamic syntax,
                                                 same plugin)

Each page is a default-exported React component:

```tsx
// src/pages/about.tsx
export default function About() {
  return <Box sx={{ p: 4 }}>About this app</Box>;
}
```

Add a sidebar link via `frontend/src/app/components/Layout/Sidebar.tsx`.

---

## Styling — MUST use the design token system

The template ships a complete design system at `frontend/src/shared/styles/ThemeContext.tsx`.
Use tokens via the `useClaudeTokens()` hook (or whatever the template exposes — check the file).
**Don't hand-roll hex colors or pixel values.**

Patterns:

```tsx
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export default function Card() {
  const c = useClaudeTokens();
  return (
    <Box sx={{
      bgcolor: c.bg.surface,
      border: `1px solid ${c.border.subtle}`,
      borderRadius: 2,
      p: 3,
    }}>
      <Typography variant="h2" sx={{ color: c.text.primary }}>
        Hello
      </Typography>
    </Box>
  );
}
```

- **Use MUI components** (`Box`, `Typography`, `Button`, `IconButton`, `Tooltip`, `Stack`, etc.) — never write raw `<div>` for layout.
- **Use the `sx` prop** for styles, not separate CSS files.
- **Don't add Tailwind**, Bootstrap, or any other CSS framework.

Check `frontend/DESIGN.md` for the complete design system spec.

---

## State management — Redux Toolkit

Store is at `frontend/src/shared/state/store.ts`. Add new slices following
the `tempStateSlice.ts` pattern (createSlice, named action creators, register
the reducer in the store).

```tsx
import { useAppDispatch, useAppSelector } from '@/shared/hooks';

function MyComponent() {
  const items = useAppSelector(s => s.myFeature.items);
  const dispatch = useAppDispatch();
  // ...
}
```

For server data, use plain async thunks (`createAsyncThunk`) or fetch
directly inside `useEffect` — no react-query in the template (yet).

---

## Backend — opt-in, never roll your own

The workspace **starts without a backend**. If your app needs server-side
code (API endpoints, secrets, server-managed state):

```bash
bash backend_init.sh
```

This script COPIES the canonical backend scaffold (FastAPI + SubApp pattern
+ swarm-debug pre-installed) into your workspace, allocates a free port,
and flips `BACKEND_PORT` in both `.env` and `.env.example`. Then **hard-
reload the preview** (right-click the reload button) so the runtime
restarts and brings the backend up.

**You MUST NOT roll your own backend.** Do not:
- Hand-write a `backend/main.py` from scratch.
- Use Flask, Django, or any framework other than the FastAPI scaffold
  the script gives you.
- Install your own venv or `pip install` manually.
- Edit `backend/run.sh` or the SubApp framework.

Adding a new endpoint is just adding a new SubApp:

```python
# backend/apps/jobs/jobs.py
from contextlib import asynccontextmanager
from backend.config.Apps import SubApp
from swarm_debug import debug

@asynccontextmanager
async def jobs_lifespan():
    debug("jobs SubApp lifespan starting")
    yield

jobs = SubApp("jobs", jobs_lifespan)

@jobs.router.get("/list")
async def list_jobs():
    return {"jobs": [...]}
```

Then register it in `backend/main.py`:

```python
from backend.apps.jobs.jobs import jobs
main_app = MainApp([health, jobs])
```

Routes are auto-prefixed: `jobs.router.get("/list")` becomes
`GET /api/jobs/list` — accessible from the frontend at `fetch('/api/jobs/list')`.

---

## Frontend ↔ Backend wiring

Vite proxies `/api/*` calls from the frontend to the workspace's own
backend (on `BACKEND_PORT`). **Always call `/api/...` from frontend code**
— never hardcode `localhost:<port>`. The proxy is configured in
`vite.config.ts` and reads `BACKEND_PORT` from `.env` automatically.

```tsx
// frontend/src/pages/jobs.tsx
import { useEffect, useState } from 'react';

export default function Jobs() {
  const [jobs, setJobs] = useState([]);
  useEffect(() => {
    fetch('/api/jobs/list')
      .then(r => r.json())
      .then(data => setJobs(data.jobs));
  }, []);
  return <>{/* render jobs */}</>;
}
```

Keep ALL backend URL paths in `frontend/src/shared/state/API_ENDPOINTS.ts`
so refactors are one-file edits:

```ts
export const JOBS_LIST = '/api/jobs/list';
```

---

## Debugging — use `swarm_debug`, not `print()`

The backend has `swarm_debug` pre-installed. It's a colored frame-aware
logger that lands in the App Builder's **Terminal** tab under `[BACKEND]`.

```python
from swarm_debug import debug

debug(value)          # [endpoint_name] : value = ...
debug(a, b, c)        # logs all three with labels
debug(err)            # red + ❌ if variable is an exception
```

See the **swarm-debug Logger** built-in skill (Skills page) for the full
reference. `print()` works too but lacks the variable-name inference and
colorization.

Frontend `console.log/warn/error` calls land in the Terminal pane under
`[FRONTEND]` via the App Builder's webview-preload bridge. Same chronological
stream as `[BACKEND]` lines, so you can correlate cause and effect across
the two halves of your stack.

---

## Adding npm packages

Just `npm install <package>` in the workspace's `frontend/` directory.
Vite picks it up on the next HMR cycle.

```bash
cd frontend && npm install lodash @types/lodash
```

Then import normally — Vite resolves it.

Common deps already in the template:
- `@mui/material`, `@mui/icons-material` — use these for any UI primitive
- `@reduxjs/toolkit`, `react-redux`
- `framer-motion` — for animations
- `react-router-dom@7`
- `vite-plugin-pages` — file-based routing (already configured)

---

## ⚠️ Don't

- **Don't rename `index.html` or `run.sh`** — the runtime needs both at fixed paths.
- **Don't edit `vite.config.ts`** unless you know exactly why. The `/api` proxy and `vite-plugin-pages` config are load-bearing.
- **Don't write a standalone HTML file** at the workspace root. There's no longer a `serve/index.html` endpoint for new-mode workspaces — the webview points at Vite's dev server.
- **Don't hand-roll a backend**. Use `bash backend_init.sh`.
- **Don't bypass MUI** with raw `<div>` + custom CSS. Use `Box`, `Stack`, `sx`.
- **Don't hardcode `localhost:<port>`**. Use relative `/api/...` paths so the Vite proxy handles routing.

---

## Workflow tips

- **Edits are auto-saved**. As soon as you write a file via the Edit/Write tool, it's on disk. Vite HMR re-renders the preview within ~100ms.
- **Hard Reload (right-click the reload button)** restarts the runtime — useful after you `bash backend_init.sh` or change `.env` values.
- **`meta.json`** at workspace root is shown in the OpenSwarm Apps page UI. Update its `name` and `description` when the app's purpose changes.

---

## Quick start checklist

When making a new app from scratch:

1. Replace `frontend/src/pages/index.tsx` with your home page.
2. Add additional pages under `frontend/src/pages/`.
3. Add a sidebar nav entry in `frontend/src/app/components/Layout/Sidebar.tsx`.
4. Style with `useClaudeTokens()` and MUI's `sx`.
5. If you need a backend: `bash backend_init.sh`, then add a SubApp under `backend/apps/<name>/`.
6. Update `meta.json` with the app's name + description.
