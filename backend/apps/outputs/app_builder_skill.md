# App Builder — Platform Reference

You are building an **App** inside OpenSwarm. The workspace you're working
in is a **React 18 + TypeScript + Vite** project (with an optional FastAPI
backend you can opt into on demand). It's served live to a webview, so it
behaves like a real browser tab — cross-origin `fetch`, popups, mic/camera,
clipboard, anything a normal web page does.

---

## STEP 0 — pick the right shape for the app

Before writing any code, decide whether this app should be **workspace**
(full React/MUI, the default) or **lightweight** (one self-contained
`index.html`). Picking wrong wastes the user's time: the workspace path
spends ~10-30 s pre-bundling MUI and React on first preview, which is
pointless when the app is a 200-line Three.js demo.

**Lightweight** when ALL apply:
- One page, no route navigation
- No persisted server state (no DB-shaped data the user comes back to)
- No real backend logic (just CDN libraries, in-memory state)
- The whole UI is essentially one of: canvas/WebGL scene, single-file
  visualization (D3/Plotly/Chart.js), single-purpose tool (formatter,
  calculator, color picker), tiny game or simulator

**Workspace** (this document's default) when ANY apply:
- Multiple pages with sidebar/route navigation
- Multiple distinct UI sections with their own state
- Real backend (FastAPI endpoints, file uploads with server processing,
  auth, persisted user data)
- Real-time updates (WS/SSE)
- The user is likely to ask for more features later (chat, dashboards,
  CRUD apps — these grow)

**Examples — lightweight:** "rotating Three.js cube", "Pomodoro timer",
"JSON formatter", "Mandelbrot explorer", "CSV → bar chart (no save)",
"first-person Minecraft-style demo", "color picker", "regex tester".

**Examples — workspace:** "chat app", "PDF previewer with annotations",
"task manager with categories", "recipe app", "weather dashboard with
saved cities", "Slack-style team chat with channels".

If you're unsure, lean **workspace** — it's strictly more capable and the
boot cost only hits once per app, then warm cache makes subsequent boots
fast.

### Lightweight — how

1. Delete everything under `frontend/src/` (`index.tsx`, `app/`, `pages/`,
   `shared/`). Vite serves `frontend/index.html` directly when there's no
   module graph to crawl, so the pre-bundle step is skipped entirely.
2. Replace `frontend/index.html` with a single self-contained document.
   Inline `<style>` and `<script>`. Pull libraries from `esm.sh` /
   `unpkg` via `<script type="importmap">` or plain `<script src=...>`.
3. Leave `frontend/package.json`, `frontend/vite.config.ts`, `run.sh`,
   `.env`, `meta.json` alone — vite still needs them.
4. Don't run `bash backend_init.sh` — lightweight mode has no backend.

The rest of this document covers **workspace mode**. If you picked
lightweight, only the "Debugging" section (frontend console logs in the
Terminal pane) is relevant; skip everything else.

You are **NOT** writing a single HTML file or vanilla JS *inside a
workspace*. If you picked workspace mode above, match the codebase's
patterns described below.

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

- `src/pages/index.tsx`           → `/`  (ships with a "Brewing your app"
                                          placeholder — overwrite first)
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

### MUI imports — ALWAYS use path imports, NEVER barrel imports

This is non-negotiable. Vite pre-bundles every entry in a barrel import,
which means a single `import { Button } from '@mui/material'` forces Vite
to optimize 200+ MUI sub-modules — adding ~10–15 seconds to every cold
boot of the workspace's preview. MUI's own performance guide
(<https://mui.com/material-ui/guides/minimizing-bundle-size/>) recommends
path imports for exactly this reason.

```tsx
// ✅ DO — path imports, one per component
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

// ❌ DON'T — barrel imports drag in all of @mui/material
import { Button, Box, Stack, Typography } from '@mui/material';
```

Same rule for icons — even more important there because
`@mui/icons-material` re-exports thousands of SVG components:

```tsx
// ✅ DO
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

// ❌ DON'T
import { Add, Delete } from '@mui/icons-material';
```

**Icon discipline:** keep icon imports to the minimum the UI actually
uses. If a page only needs 4 icons, import 4 — don't pre-import 20 for
"maybe later." Each icon import is another module Vite has to pre-bundle
on first boot.

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
- **`meta.json`** at workspace root drives the app's name + description in the OpenSwarm sidebar, App Builder header, and Apps page. Write it FIRST when starting a new app (see step 1 of the Quick start checklist), and revise it any time the app's purpose shifts.

---

## Verify before declaring done — runtime errors are silent in the preview

The preview iframe is wrapped in an ErrorBoundary that surfaces React
runtime errors as a visible red error card AND mirrors the error into
the Terminal pane as a `[FRONTEND]` line tagged `[openswarm:app-error]`.
After substantial edits — especially anything that touches imports,
hooks, or React state — **always check the most recent `[FRONTEND]`
lines in your Terminal output before saying "done"**. If you see one,
fix it before claiming the app is ready.

The three most common ways agent edits crash a React preview:

1. **Lost import after MultiEdit / Edit.** When you delete or rename a
   symbol's usage inside a file but don't update the corresponding
   `import` line, the file references an undefined name at runtime.
   Symptom in Terminal: `[FRONTEND] ReferenceError: HomeIcon is not defined`
   or similar. Always re-read the imports block of any file you
   edited and confirm every imported name is still used and every
   used name is still imported.

2. **`Invalid hook call` from a duplicate React copy.** The single
   most common way to break a workspace. Symptom in Terminal:
   `[FRONTEND] Cannot read properties of null (reading 'useState')`
   AND `Invalid hook call ... You might have more than one copy of
   React in the same app`. Happens when an `npm install` brought in
   a package that bundles its own React (instead of declaring it as
   a peer), so there are now TWO React instances in the workspace's
   `node_modules` and the two copies' hook dispatchers can't see each
   other.

   **Fix (one shot):** from the workspace root run

   ```bash
   rm -rf frontend/node_modules && rm -rf frontend/.vite-cache
   ```

   Then trigger Hard Reload on the preview (right-click the reload
   button in the toolbar). The workspace's `frontend/node_modules`
   will re-symlink to the shared warm cache on next vite boot — only
   ONE React copy exists across all App Builder apps, so the
   duplicate is gone. The `.vite-cache` wipe is important because
   vite caches pre-bundled deps including the duplicate React.

   **How to avoid causing it in the first place:**
   - **Never `npm install react` / `react-dom`** — the template
     already has them via the symlinked warm cache.
   - Before `npm install <pkg>`, check the package's `peerDependencies`
     on npmjs.com. If `react` is listed under `peerDependencies` (good)
     install it. If `react` is in `dependencies` (bad), find a
     different package or pin a version known to use peer deps.
   - Common offenders: older `react-pdf`, `react-pdf-viewer`, some
     `@react-*` UI kits, anything from a tutorial published before
     2020.

3. **Hooks called outside a component body or after a conditional
   return.** `useState`/`useEffect`/`useMemo` must run in the same
   order on every render. Adding an `if (...) return null` BEFORE a
   hook, or calling a hook inside a callback, breaks the rule. The
   ErrorBoundary will print the offending component name in the
   surfaced stack — start there.

When in doubt, read the file you just edited end-to-end one more time.
Re-reading is cheap; sending a half-broken preview back to the user is
not.

---

## Quick start checklist

When making a new app from scratch:

1. **WRITE `meta.json` FIRST**, before any other tool call. Put a 1-3 word product
   name (Title Case) in `name` and a one-sentence description in `description`.
   The Apps sidebar and the App Builder header show this name to the user; until
   you write it, both surfaces sit at "Untitled App". Don't wait until the end of
   the turn to fill it in — pick a name from the user's prompt and ship it now.
   Example: prompt "make doodle jump" → `{"name": "Doodle Jumper", "description":
   "Endless platform-hopper inspired by Doodle Jump."}`. You can revise it later
   if the app's purpose shifts.
2. **REPLACE** `frontend/src/pages/index.tsx`. The starter ships with a
   "Brewing your app" placeholder — this is intentional, it's what the user
   sees between React mounting and your first edit landing, and it must
   disappear the moment your real home page is ready. Rewrite the whole
   file with your app's actual `<Home>` component. (There's also an even
   earlier inline splash in `index.html` that paints before any JS bundle
   loads — leave that alone; React's first commit clears it automatically.)
3. **Sidebar / shell is OPT-IN.** `Main.tsx` no longer wraps pages in
   `<AppShell>`. If your app needs a sidebar (SaaS-style dashboards,
   multi-page apps), import `AppShell` from
   `@/app/components/Layout/AppShell` and wrap your page in it yourself:
   ```tsx
   import AppShell from '@/app/components/Layout/AppShell';
   export default function Home() {
     return <AppShell><YourContent /></AppShell>;
   }
   ```
   Most apps DON'T want a sidebar (games, canvases, single-screen tools,
   previewers, full-bleed visualizations) — just render your content directly
   and the page will be full-bleed. Don't add a shell out of habit.
4. Add additional pages under `frontend/src/pages/`.
5. If using a sidebar, update its nav entries in
   `frontend/src/app/components/Layout/Sidebar.tsx`.
6. Style with `useClaudeTokens()` and MUI's `sx`.
7. If you need a backend: `bash backend_init.sh`, then add a SubApp under `backend/apps/<name>/`.
