# frontend/CLAUDE.md

React 18 + TypeScript + webpack 5 + Redux. Entry: `src/app/Main.tsx`. Dev server on `:3000` proxies REST and WebSocket to backend on `:8324`. See root `CLAUDE.md` for repo-wide constraints.

## Coding precedences

Full precedences live in root [CLAUDE.md](../.claude/CLAUDE.md). Always: **understand the end goal before coding** (what does the user actually need?); **reuse before you write** (grep existing components / hooks / Redux slices, most needs already have one); ~300 LOC/file ceiling; downward-tree imports (`shared/` → `app/components/` → `pages/`); no comments except WHY-non-obvious; **no em-dashes or en-dashes anywhere** (`—`, `–`); say IDK to the user when you don't know, then go find out; manually exercise the UI after meaningful changes; weigh speed (no double renders), efficiency, robustness, UX (loading/error/animation states), and security on every change.

## Run

- Dev (full stack): `bash run.sh`.
- Dev (frontend only): `bash frontend/run.sh` (runs `npm install` then `npm run dev`).
- No JS/TS test runner is wired up. Changes must be manually exercised in the running app before merging.

## Key concepts

- **Spatial dashboard.** Agents are draggable nodes on a canvas; layout + selection state lives in Redux.
- **Settings draft persistence.** `AppSettings.dismissed_mcp_suggestions` is a map of MCP id → ISO timestamp; preserve this shape when modifying settings serialization.
- **Onboarding wizard** (`src/app/components/Onboarding/`). 8-step agentic cursor walkthrough. Cursor offsets, fit-to-view, AC popup timing, and group-meta dedup were each delicate to land; verify visually after touching this code. Note: steps 3/5/6 launch real agent sessions that hit the cloud's analytics ingest, so don't treat them as visual-only.
- **SignInGate** (`src/app/components/SignInGate.tsx`, mounted in `Main.tsx`). First-launch gate that captures `user_id` + email via Google OAuth or email magic link, hitting the cloud's `/api/auth/{google,email}/*`. Auto-dismisses for users with a valid bearer.
- **Custom providers.** `AppSettings.custom_providers: CustomProvider[]` supports any OpenAI-compatible endpoint (e.g. LM Studio).

## Conventions

- TS only; no PropTypes.
- No eslint/prettier config; match nearby files.
- Onboarding-copy placeholders shaped like real API keys (`sk-ant-api03-…`) are already allowlisted in `.gitleaks.toml`. Reuse the existing placeholder rather than introducing new "example" tokens.
- MCP suggestion UI must surface only the vetted/default set; never expose the full upstream registry to users.

## Dev vs production

The dev server (`webpack-dev-server` on `:3000`) and the packaged DMG/EXE serve the app differently. Test in the packaged build for any change touching the items below.

- **Server:** dev uses webpack-dev-server with HMR and a `/api/*` + `/ws/*` proxy to `:8324`. Prod loads built static `dist/` from inside an Electron `asar` archive via `file://`.
- **API + WS:** in both modes, the backend lives at `localhost:8324` with bearer-token auth. Dev relies on the dev-server proxy; prod fetches direct. Don't bake in dev-only proxy assumptions.
- **Asset paths:** `public/` files are served at `/` in dev. In prod, asset URLs resolve relative to a `file://` document; prefer relative imports/URLs over absolute `/foo.png`.
- **Source maps + HMR:** dev only. Prod runs minified bundles; console errors land in the Terminal pane's `[FRONTEND]` lines.

When you touch routing, fetch wiring, asset loading, or WS plumbing, build with `npm run build` and run the packaged DMG/EXE to verify.

## Pitfalls

- Direct LLM calls from the frontend bypass the backend's provider routing and MCP gate. Don't add them; route through `/api/*` instead.
- Webpack-dev-server hot reload occasionally loses WS state; full page reload after backend restarts.
- MUI `Menu`/`Popover`/`Modal` portals dropped over an Electron `<webview>` inside the zoom/pan canvas eat clicks intermittently. Webviews are a separate compositor layer that CSS `pointer-events` and z-index can't reliably beat. Don't float a menu over a webview: open it into empty canvas, use plain `position:fixed` JSX you control, or make it a direct action (right-click does the thing, no menu).
- Reset/clear handlers must clear local component state, not just the Redux slice. `clearSessionMessages` only wipes `session.messages`; AgentChat's `showResumeBubble`, `awaitingResponse`, and message queue are React state and survive, leaving a stale "thinking" bubble or Resume button. Clear both.
- Don't GC a session/draft on unmount without checking it isn't mid-launch. `launchAndSendFirstMessage` races against route-change unmount; deleting a draft that already has user messages orphans the backend session and reads as "everything got wiped" on reopen. Guard on message count.
- Don't write placeholder strings into fields the UI renders as real data. The Google Workspace pill showed "Google Workspace account" because the connected email fell back to `f"{tool.name} account"`; leave the field empty and let the UI's empty-state handle it.
