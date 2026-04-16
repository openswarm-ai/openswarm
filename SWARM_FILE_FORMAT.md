# `.swarm` File Format Specification

**Status:** Draft v1.0
**Goal:** Let OpenSwarm users share a fully-working dashboard — including every skill, tool, app, template, and mode it depends on — as a single file.
**Constraint:** Minimal changes to the existing codebase. This feature is a thin layer on top of the existing `dashboards/`, `skills/`, `tools_lib/`, `outputs/`, `templates/`, and `modes/` modules. It reuses their existing CRUD functions and does not modify their schemas, tables, or endpoints.

---

## 1. Design principles

1. **One format.** Users export a dashboard and get a `.swarm` file. They import a `.swarm` file and get a working dashboard. No other formats, no modal asking "layout or bundle", no choice to make.
2. **Thin layer.** All export/import logic lives in one new module (`backend/apps/portable/`). It calls the *existing* read and write functions in the other modules. No existing module gets modified beyond adding it to the FastAPI app registry.
3. **ZIP container with a manifest.** Same pattern as `.docx`, `.vsix`, `.crx`. Free compression, trivial inspection, every language has a zip library.
4. **No secrets in files, ever.** Enforced at export time. Required env vars become user-filled placeholders at import time.
5. **Loud warnings on code execution.** Apps with Python backends and MCP tools with `stdio` transport execute code on the importer's machine. The import preview makes this unmistakable.

---

## 2. File structure

A `.swarm` file is a ZIP archive. This is the canonical layout:

```
my-dashboard.swarm
├── manifest.json              # required — describes the bundle
├── dashboard/
│   ├── dashboard.json         # dashboard row + canvas state
│   └── layout.json            # card positions, sizes, z-order
├── skills/
│   └── <skill_id>/
│       ├── skill.json         # skill row from DB
│       └── files/             # SKILL.md + any referenced assets
│           └── SKILL.md
├── tools/
│   └── <tool_id>/
│       └── tool.json          # MCP server config with secrets stripped
├── apps/
│   └── <app_id>/
│       ├── app.json           # app row from DB
│       ├── frontend/
│       │   └── index.html
│       └── backend/           # optional
│           ├── main.py
│           └── requirements.txt
├── templates/
│   └── <template_id>/
│       └── template.json
└── modes/
    └── <mode_id>/
        └── mode.json
```

Empty directories are omitted. A dashboard with no custom modes won't have a `modes/` folder.

---

## 3. `manifest.json` schema

```json
{
  "format": "swarm",
  "format_version": "1.0",
  "openswarm_min_version": "0.x.x",

  "bundle": {
    "id": "uuid-v4",
    "name": "Human-readable dashboard name",
    "description": "Optional longer description",
    "author": {
      "name": "Optional author name",
      "url": "Optional URL"
    },
    "created_at": "2026-04-14T00:00:00Z",
    "checksum": "sha256:..."
  },

  "contents": {
    "dashboard": { "id": "...", "name": "..." },
    "skills":    [ { "id": "...", "name": "...", "version": "..." } ],
    "tools":     [ { "id": "...", "name": "...", "transport": "stdio|http|sse" } ],
    "apps":      [ { "id": "...", "name": "...", "has_backend": true } ],
    "templates": [ { "id": "...", "name": "..." } ],
    "modes":     [ { "id": "...", "name": "..." } ]
  },

  "required_env": [
    {
      "key": "GITHUB_TOKEN",
      "component_type": "tool",
      "component_id": "...",
      "description": "GitHub personal access token for the GH tool",
      "required": true
    }
  ],

  "warnings": {
    "executes_code": true,
    "executes_code_reasons": [
      "App 'CodeRunner' contains a Python backend",
      "Tool 'LocalFS' uses stdio transport"
    ]
  }
}
```

**Field notes:**

- `format_version` uses semver on the file format itself, not OpenSwarm's version. Additive changes bump minor; breaking changes bump major.
- `openswarm_min_version` lets old exports refuse to install on too-new builds if the format later changes incompatibly.
- `checksum` is computed over the concatenated sha256 of every file in the archive except `manifest.json` itself. Verified on import; mismatch refuses the import.
- `required_env` is the single most important field for security. Every placeholder in every component's config shows up here so the import UI can collect values in one screen.
- `warnings.executes_code` is `true` if any component in the bundle runs code on the importer's machine. Set at export time based on tool transports and app backends.

---

## 4. Per-component serialization rules

Each component type gets serialized by calling the **existing read function** in its module and writing the result to JSON. No existing serializer or schema needs to change.

### 4.1 Dashboard (`dashboard/`)

- `dashboard.json`: the dashboard row from the `dashboards` table as returned by the existing `get_dashboard(id)` function.
- `layout.json`: the layout state from the existing `dashboard_layout/` module — card positions, sizes, z-order, card type, and the `component_id` each card points to.

**ID rewriting on import:** dashboard ids, skill ids, tool ids, app ids, template ids, and mode ids all get regenerated on import to avoid collisions with whatever the importer already has. The import code walks `layout.json` and every component-reference field in `dashboard.json` and rewrites old ids → new ids using a translation map built during component installation.

### 4.2 Skills (`skills/`)

Per the repo, OpenSwarm skills sync to `~/.claude/skills/{skill_name}/` and consist of a `SKILL.md` plus optional referenced files.

- `skill.json`: the DB row.
- `files/`: a direct copy of the skill's folder on disk (`SKILL.md` plus any assets it references).

Import calls the existing skill-create function with the JSON row, then writes the files into `~/.claude/skills/{new_skill_name}/`.

### 4.3 Tools (`tools/`)

Tools in OpenSwarm are MCP server configs (stdio command, HTTP URL, or SSE endpoint) plus per-tool permission settings.

- `tool.json`: the DB row, **with all secret values stripped**.

**Secret stripping at export time:**

```python
SECRET_KEY_PATTERNS = [
    r".*_?TOKEN$", r".*_?KEY$", r".*_?SECRET$",
    r".*_?PASSWORD$", r".*_?PASS$", r".*CREDENTIAL.*",
    r".*AUTH.*", r".*API.*KEY.*",
]
```

For any `env` entry whose key matches one of these patterns, the value is replaced with `"${USER_PROVIDED}"` and an entry is added to `manifest.json`'s `required_env` array. OAuth token fields are *always* stripped regardless of key name.

Stdio transport tools trigger `warnings.executes_code = true` because they spawn a local process.

### 4.4 Apps (`apps/`)

Apps are OpenSwarm's Views/Outputs — HTML frontend plus optional Python backend, per the repo's `outputs/` module.

- `app.json`: the DB row.
- `frontend/`: direct copy of the frontend files.
- `backend/`: direct copy of the backend files, if one exists. Also strip secrets from any `.env` or config file following the same rules as tools.

Any app with a backend triggers `warnings.executes_code = true`.

### 4.5 Templates (`templates/`)

Templates are parameterized prompts with structured input fields, invoked via slash commands. Simple — just serialize the DB row:

- `template.json`: the row.

### 4.6 Modes (`modes/`)

Modes are system-prompt + tool-restriction profiles. Same pattern as templates:

- `mode.json`: the row.

Only custom user-defined modes get exported. The five built-in modes (Agent, Ask, Plan, View Builder, Skill Builder) are referenced by name in `dashboard.json` and assumed to exist on the importer's side.

---

## 5. Export flow

**Entry point:** `POST /api/portable/export/dashboard/{dashboard_id}` → returns a `.swarm` file.

**Algorithm:**

1. Load the dashboard via existing `get_dashboard(id)` and existing layout getter.
2. Walk the layout to collect every referenced `component_id` grouped by type (skills, tools, apps, templates, modes).
3. For each referenced component, call the existing getter in its module to load the row. For skills and apps, also load files from disk.
4. Build an in-memory archive:
   - Strip secrets from tool configs and app backend env files. Record stripped keys in a running `required_env` list.
   - Scan for stdio tools and apps with backends to populate `warnings`.
   - Write each component under its folder in the archive.
5. Compute the checksum and write `manifest.json`.
6. Zip and stream as a file download.

**Nothing is written to disk on the server during export.** The archive is built in memory (`io.BytesIO`) and streamed to the client.

---

## 6. Import flow

**Entry point:** `POST /api/portable/import` with the `.swarm` file attached.

Split into **two phases** so the user sees what they're about to install before anything hits their system.

### Phase 1: Preview (`?preview=true`)

1. Open the zip in memory.
2. Parse `manifest.json`. Reject if `format != "swarm"` or `format_version` major doesn't match.
3. Verify the checksum. Reject on mismatch.
4. Verify `openswarm_min_version` compatibility.
5. Return a preview payload to the frontend:
   - `contents` from the manifest (what's about to be installed)
   - `warnings` from the manifest (loud code-execution warnings)
   - `required_env` from the manifest (what secrets the user needs to provide)
   - `conflicts` — a list of components where an existing component with the same **name** (not id) is already installed, so the user can choose replace/rename/skip per item.

### Phase 2: Install

User submits the preview response plus:
- their filled-in env var values (one text field per `required_env` entry)
- their conflict resolutions (one choice per conflict)

The installer:

1. Builds an **id translation map**, component by component.
2. For each component, calls the existing *create* function in the target module:
   - `skills`: existing skill-create; writes files to `~/.claude/skills/`
   - `tools`: existing tool-create; substitutes user-provided env values for `${USER_PROVIDED}` placeholders
   - `apps`: existing app/output-create; writes frontend and backend files; substitutes env values
   - `templates`: existing template-create
   - `modes`: existing mode-create
3. After all components exist and the translation map is complete, rewrite component references in `dashboard.json` and `layout.json` using the map.
4. Call the existing dashboard-create and layout-create functions with the rewritten JSON.
5. Return the new dashboard id so the frontend can navigate to it.

**Transactional behavior:** if any step fails, roll back by calling the existing delete functions on every component installed so far in this import. The user should never end up with a half-imported dashboard.

---

## 7. Frontend changes

Deliberately minimal — one export button per dashboard, one global import button, one preview modal.

### Export button

On the dashboard page header, add an "Export" menu item next to the existing dashboard settings. Clicking it calls `GET /api/portable/export/dashboard/{id}` and triggers a browser download. No modal, no options.

### Import button

In the top nav or on the dashboards list page, add an "Import .swarm" button. It opens a file picker. On file selection, calls `POST /api/portable/import?preview=true` and shows the preview modal.

### Preview modal

Shows four sections, in order:

1. **What's inside** — list of components from `contents`, grouped by type, with counts.
2. **⚠️ Code execution warning** (only if `warnings.executes_code`) — red banner listing the reasons. "This bundle will run code on your machine. Only import from sources you trust."
3. **Required credentials** (only if `required_env` is non-empty) — one text input per entry. Each shows the key name and the description from the manifest.
4. **Conflicts** (only if any) — for each conflict, a dropdown: Replace / Rename / Skip.

Bottom of the modal: **Cancel** and **Install**.

---

## 8. Backend changes

This is the full list of new files. Nothing existing gets modified.

```
backend/apps/portable/
├── __init__.py
├── portable.py          # FastAPI router, export and import endpoints
├── schemas.py           # Pydantic models: Manifest, Contents, RequiredEnv, Warnings
├── exporter.py          # build_swarm_bundle(dashboard_id) -> bytes
├── importer.py          # preview_swarm_bundle(bytes), install_swarm_bundle(bytes, env, conflicts)
├── secrets.py           # strip_secrets_from_tool_config, strip_secrets_from_env_file
└── idmap.py             # IdTranslationMap helper, ref-rewriting in dashboard/layout JSON
```

One line gets added to the FastAPI app registration wherever other SubApps are registered, to include the portable router. That's the only existing-file change.

The portable module imports from the existing modules (`from apps.dashboards import ...`, `from apps.skills import ...`, etc.) and calls their existing public functions. It does not touch their internals.

---

## 9. Security rules (non-negotiable)

1. **Never export secret values.** The secret-stripping step runs before anything gets written into the archive. Unit tests should assert that for known secret key patterns, the exported JSON contains `"${USER_PROVIDED}"` and the `required_env` array has the key listed.
2. **Never bypass the import preview.** Even if the user has imported this exact file before, preview runs every time. No "trust this publisher" mechanic in v1.
3. **Refuse unsigned format changes.** If `format_version` major doesn't match what the installed OpenSwarm knows, the import is refused with a clear error pointing at the version field. Don't silently try to interpret future formats.
4. **Checksum verification is mandatory.** A tampered or corrupted archive refuses to import.
5. **Code execution is surfaced in the UI, not hidden in the manifest.** The preview modal shows the red banner prominently.
6. **Reserve a `signature` field in the manifest for v1.1** — optional author signature with public key and sig. Not required, but leaving the field reserved now avoids a breaking change when it's added. Importer in v1.0 can ignore the field if present.

---

## 10. What this spec deliberately leaves out

- **A marketplace, registry, or sharing service.** That's a product question, not a file format question. `.swarm` files are shared by whatever means users already share files — email, Slack, Drive, GitHub. Adding a marketplace later doesn't require changing the format.
- **Partial exports.** No "export just the skills" button. If the four-format family (`.swarmsk`, `.swarmtl`, `.swarmapp`, `.swarmdb`) is ever reintroduced, it becomes four export endpoints that reuse 90% of `exporter.py`. Not planned for v1.
- **Cross-version migration.** If a dashboard was exported from OpenSwarm 0.5 and the importer runs 0.9, the components install fine (their formats haven't changed), but no automatic migration of dashboard-level fields is attempted. `openswarm_min_version` handles the refusal case.
- **Diff / merge on import.** If the importer already has a skill named "MyHelper" with different contents, the conflict UI offers Replace / Rename / Skip. Not three-way merge.

---

## 11. Build order

1. **`schemas.py`** — Pydantic models for the manifest. Pure data, no logic. Easy PR to land first.
2. **`secrets.py` + unit tests** — secret-stripping logic in isolation, with tests covering every known key pattern. This is the security-critical piece; worth having in its own PR with thorough review.
3. **`exporter.py` + `GET /api/portable/export/dashboard/{id}`** — end-to-end export working, archive downloads correctly, manifest validates against schemas. At this point you can export but not yet import.
4. **`importer.py` preview phase + `POST /api/portable/import?preview=true`** — preview works, returns conflicts and required_env correctly.
5. **`importer.py` install phase + full `POST /api/portable/import`** — install works with id rewriting and transactional rollback. End-to-end round-trip works: export a dashboard, install it, get an identical working dashboard.
6. **Frontend export button.**
7. **Frontend import button + preview modal.**
8. **(v1.1)** Optional signing field.

Each step is independently shippable and the feature becomes useful to users at step 7.

---

## Appendix A: Example manifest for a real dashboard

```json
{
  "format": "swarm",
  "format_version": "1.0",
  "openswarm_min_version": "0.4.0",
  "bundle": {
    "id": "3f9a...",
    "name": "Research Desk",
    "description": "Three-agent research workflow with a custom summarizer skill and a local filesystem tool.",
    "author": { "name": "Manny", "url": "https://openswarm.info" },
    "created_at": "2026-04-14T17:32:11Z",
    "checksum": "sha256:a81c9f..."
  },
  "contents": {
    "dashboard": { "id": "3f9a...", "name": "Research Desk" },
    "skills": [
      { "id": "sk_01", "name": "summarizer", "version": "1.2.0" }
    ],
    "tools": [
      { "id": "tl_01", "name": "local-fs", "transport": "stdio" },
      { "id": "tl_02", "name": "github-mcp", "transport": "http" }
    ],
    "apps": [
      { "id": "ap_01", "name": "results-board", "has_backend": false }
    ],
    "templates": [
      { "id": "tp_01", "name": "research-brief" }
    ],
    "modes": []
  },
  "required_env": [
    {
      "key": "GITHUB_TOKEN",
      "component_type": "tool",
      "component_id": "tl_02",
      "description": "GitHub personal access token for the github-mcp tool",
      "required": true
    }
  ],
  "warnings": {
    "executes_code": true,
    "executes_code_reasons": [
      "Tool 'local-fs' uses stdio transport and will spawn a local process on import"
    ]
  }
}
```
