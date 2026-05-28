# Code Quality Tools

This folder contains the project's code quality tooling: a structural linter, dead code detection, and type checking — covering both the Python backend and TypeScript frontend.

## What gets checked

### Structural rules

**File length** — Every source file must stay under the configured line limit (see `max-file-lines` in `config.json`). Big files are hard to read, review, and maintain. If a file is getting long, it's a sign it should be split.

**Folder size** — Every folder must contain fewer than `max-folder-items` entries (configured in `config.json`). Keeping folders small forces you to organize code into logical groups.

**Unused Python code (Vulture)** — Flags unused functions, classes, variables, and imports in the backend. Integrated into the linter's watch loop — findings appear as warnings in the Problems panel alongside structural errors. Confidence thresholds are configurable via `vulture-min-confidence` and `vulture-error-threshold`.

These rules apply to `.py`, `.ts`, `.tsx`, `.js`, and `.jsx` files.

### Orphaned endpoints

**Endpoint check** — Cross-references backend API routes (decorator and `add_api_route` patterns) with the frontend source and other backend files. Routes whose static path segments don't appear anywhere else are flagged as orphaned. Backend-only endpoints (health checks, OAuth callbacks, etc.) can be excluded via the `endpoints` exception list or `endpoint-ignore-routes` patterns in `config.json`.

### Class analysis

**Class check** — Analyses classes in backend Python files. Pydantic `BaseModel` subclasses are auto-whitelisted (every annotated field is part of the serialization schema). Non-framework classes are reserved for future cross-reference analysis.

### Unused TypeScript code

**Per-file (ESLint)** — Catches unused variables, parameters, and imports within each file. Runs in real-time through the VS Code ESLint extension.

**Project-wide (Knip)** — Finds unused exports, unused files, and unused `package.json` dependencies across the entire frontend. Run manually or in CI.

### Type checking

**Python (Pyright/Pylance)** — Strict type checking for the backend, configured via `config/pyrightconfig.json`. Works through the Pylance extension in real-time.

**TypeScript** — The `tsconfig.json` in `frontend/` has strict mode enabled. TypeScript errors show in the editor automatically.

## How it runs

### Linter watch (automatic)

When you open the project in Cursor/VS Code, a background task starts watching for file changes. Every save re-checks the codebase. Violations show up in the **Problems panel** (`Cmd+Shift+M`).

```bash
# one-shot check (exits with code 1 if violations exist)
python3 linter/lint.py --root .

# continuous watch mode
python3 linter/lint.py --watch --root .
```

### ESLint (automatic)

The VS Code ESLint extension picks up `frontend/eslint.config.mjs` and shows errors inline as you type. To run from the terminal:

```bash
cd frontend

# check for problems
npm run lint

# auto-fix what's possible
npm run lint:fix
```

### Knip (manual / CI)

```bash
cd frontend
npm run knip
```

Or use the `knip:check` VS Code task (`Cmd+Shift+P` → "Run Task" → "knip:check").

## Configuration

### config/config.json

```json
{
  "enabled": {
    "max-file-lines": true,       // toggle each check on/off
    "max-folder-items": true,
    "no-nested-imports": true,
    "vulture": true,
    "eslint": true,
    "knip": true,
    "endpoints": true,
    "classes": true
  },
  "rules": {
    "max-file-lines": 250,        // files with >= this many lines trigger an error
    "max-folder-items": 7,        // folders with >= this many items trigger an error
    "vulture-min-confidence": 80,  // minimum confidence (0-100) to flag a finding
    "vulture-error-threshold": 90, // confidence at which a finding becomes an error
    "no-nested-imports": true,
    "endpoint-ignore-routes": ["*/callback", "*/callback/*"]  // route patterns to skip
  },
  "include_extensions": [".py", ".ts", ".tsx", ".js", ".jsx"],
  "exclude": ["node_modules", ".venv", "..."],
  "exceptions": {
    "max-file-lines": [],      // glob patterns for exempt files
    "max-folder-items": [],    // glob patterns for exempt folders
    "vulture": [],             // glob patterns for files vulture should ignore
    "endpoints": [],           // glob patterns for exempt endpoint files
    "classes": []              // glob patterns for exempt class files
  }
}
```

Set any key in `"enabled"` to `false` to skip that check entirely. Missing keys default to `true`, so existing configs without the `"enabled"` section behave identically to before.

### Vulture whitelist

`config/vulture_whitelist.py` suppresses false positives — symbols used by frameworks, entry points, or external consumers that vulture can't detect statically. Add bare names to the file to mark them as intentionally used.

### ESLint

`frontend/eslint.config.mjs` — flat config format (ESLint v9). The key rule for unused code is `@typescript-eslint/no-unused-vars`. Prefix a variable with `_` to suppress the warning.

### Knip

`frontend/knip.json` — Knip auto-detects entry points from `webpack.config.js`. The `project` field tells it which files to analyze.

## Adding exceptions

If a file legitimately needs to exceed a limit, add a glob to the `exceptions` list in `config/config.json`:

```json
{
  "exceptions": {
    "max-file-lines": ["backend/tests/test_analytics.py"],
    "max-folder-items": ["backend/apps/agents"],
    "vulture": ["backend/legacy/*"]
  }
}
```

Wildcards work: `"backend/tests/*"` exempts all files in the tests folder.

## `.lintignore` files

You can suppress checks for an entire directory tree by dropping a sentinel file into it — no config edits required.

| File | Effect |
|------|--------|
| `.lintignore` | Ignores **all** rules for that directory and its children |
| `.lintignore-<rule>` | Ignores only `<rule>` (e.g. `.lintignore-max-file-lines`) |

The linter walks from each file up to the project root looking for these sentinels, so a `.lintignore` in `backend/legacy/` covers everything underneath it.

## Folder structure

```
linter/
  checks/              # check implementations
    __init__.py        # shared filter/match utilities + .lintignore support
    structural.py      # file length, folder size, nested imports
    vulture.py         # vulture dead-code runner
    eslint.py          # eslint runner
    knip.py            # knip unused-code runner
    endpoints.py       # orphaned endpoint detection
    classes.py         # class-level dead code detection
  config/              # all configuration files
    config.json        # enabled checks, rules, exclusions, exceptions
    pyrightconfig.json # python type checking config
    vulture_whitelist.py # false positive suppressions for vulture
  lint.py              # orchestrator (loads config, runs checks, outputs results)
  print_errors.sh      # colored terminal reporter
  README.md
```

## OpenSwarm setup notes

### Which checks are on

Only the pure-Python checks run today. Node tooling and the placeholder checks are
deferred.

| Check | State | Why |
|-------|-------|-----|
| `max-file-lines` (300) | on | Our 300-line precedence. Active for new files; existing debt is grandfathered (see below). |
| `max-folder-items` (7) | on | Grandfathered per subtree via `.lintignore-max-folder-items` markers in `backend/`, `frontend/`, `debugger/`, `electron/`, `scripts/`. |
| `vulture` | on | Dead-code detection over `backend/`. Runs against `backend/.venv/bin/vulture`. |
| `no-nested-imports` | off | We deliberately use function-level / lazy imports to break import cycles (400+ sites). Flagging them all is wrong for this codebase. |
| `eslint`, `knip` | off | Node tooling, deferred to a later pass. |
| `endpoints` | off | Orphaned-endpoint triage deferred. |
| `classes` | off | Placeholder check, not wired up. |

### Running it

The linter imports `watchfiles` at module load, so run it with an interpreter that
has it (the backend venv does, transitively via uvicorn):

```bash
backend/.venv/bin/python linter/lint.py --root .
```

CI installs `watchfiles` + `vulture` explicitly (see `.github/workflows/lint.yml`).

### max-file-lines grandfather list

Every file over 300 lines today lives in `exceptions["max-file-lines"]`. New files
are held to the limit. The list splits into two intents:

**PERMANENT** (one cohesive responsibility that is just genuinely large; not pending a split):
- `backend/apps/agents/agent_manager.py`
- `backend/apps/agents/browser_schema.py`
- `backend/apps/nine_router/process.py`, `backend/apps/nine_router/oauth.py`
- `backend/main.py`
- the large backend test files (`test_v2_invariants.py`, `test_disconnect_resilience.py`, `test_service.py`, `test_v2_label_logic.py`, `test_outputs_runtime_cleanup.py`)
- `electron/main.js`, `electron/affiliateTracking.test.js`
- vendored `backend/mcp-bundles/*` (covered by a `.lintignore`, not a glob entry)

**TEMPORARY (pending split)** the rest, especially the frontend mega-files:
- `frontend/src/app/pages/AgentChat/ChatInput.tsx`
- `frontend/src/app/pages/Settings/Settings.tsx`
- `frontend/src/app/pages/Tools/Tools.tsx`
- `frontend/src/app/pages/Dashboard/Dashboard.tsx`
- `frontend/src/app/pages/AgentChat/ToolCallBubble.tsx`
- and the other backend/frontend files in the list. As these get split below 300
  lines, drop their entry from the exception list.

### Vulture whitelist

`config/vulture_whitelist.py` carries OpenSwarm additions: intentional false positives
(monkey-patches, kept-for-compat aliases, loop counters) and a clearly-labelled block of
suspected genuinely-dead symbols. The latter are whitelisted only because this tooling
pass is additive-only and must not edit backend source; a future cleanup should delete
the definitions and remove those lines.
