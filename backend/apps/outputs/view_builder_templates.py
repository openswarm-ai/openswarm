"""Default template files seeded into new App Builder workspaces."""

import os
import re
import shutil

# Absolute path to the bundled skill source. Surfaced as a constant so the
# skills subsystem can register it as a built-in skill (copy into
# ~/.claude/skills/ on first boot) without re-deriving the path.
APP_BUILDER_SKILL_SOURCE_PATH = os.path.join(os.path.dirname(__file__), "app_builder_skill.md")

# Second built-in skill: documentation for `swarm-debug`, the colored
# frame-aware logger pre-installed in every webapp-template workspace's
# backend. Registered the same way as the App Builder skill.
SWARM_DEBUG_SKILL_SOURCE_PATH = os.path.join(os.path.dirname(__file__), "swarm_debug_skill.md")

# Root of the vendored openswarm-ai/webapp-template snapshot. seed_workspace
# copytrees this into new-mode workspaces (excluding backend/, which gets
# brought in on-demand by the workspace's own backend_init.sh). See
# scripts/fetch-webapp-template.sh for the snapshot fetch + patches.
WEBAPP_TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "webapp_template")

# Bundled default — used as the read-once fallback if the user-editable
# copy at ~/.claude/skills/app_builder_skill.md has been removed despite
# the built-in flag (defensive; shouldn't happen in normal use).
with open(APP_BUILDER_SKILL_SOURCE_PATH, encoding="utf-8") as _f:
    APP_BUILDER_SKILL_DEFAULT = _f.read()


def load_app_builder_skill() -> str:
    """Return the live App Builder skill content. Prefers the
    user-editable copy at ~/.claude/skills/app_builder_skill.md (so a
    user's edit on the Skills page takes effect on the very next App
    Builder agent turn — no restart, no copy-on-edit dance). Falls back
    to the bundled default if the user file is somehow gone."""
    user_path = os.path.expanduser("~/.claude/skills/app_builder_skill.md")
    if os.path.exists(user_path):
        try:
            with open(user_path, encoding="utf-8") as f:
                return f.read()
        except Exception:
            pass
    return APP_BUILDER_SKILL_DEFAULT


# Backward-compat alias. Older callers import VIEW_BUILDER_SKILL directly —
# point them at the same content as the user-editable version so a "frozen
# at import" stale copy can't drift from what the skills page shows.
VIEW_BUILDER_SKILL = APP_BUILDER_SKILL_DEFAULT

VIEW_TEMPLATE_INDEX = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>App</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      background: #1a1d27;
      border: 1px solid #2e3248;
      border-radius: 12px;
      padding: 32px;
      max-width: 600px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 8px; }
    p { color: #8892a4; font-size: 0.95rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="title">Ready</h1>
    <p id="desc">Describe what you want to build and the agent will update this app.</p>
  </div>
  <script>
    const input = window.OUTPUT_INPUT || {};
    const result = window.OUTPUT_BACKEND_RESULT || null;
  </script>
</body>
</html>
"""

VIEW_TEMPLATE_SCHEMA = """\
{
  "type": "object",
  "properties": {},
  "required": []
}
"""

VIEW_TEMPLATE_META = """\
{
  "name": "",
  "description": ""
}
"""

VIEW_TEMPLATE_FILES = {
    "index.html": VIEW_TEMPLATE_INDEX,
    "schema.json": VIEW_TEMPLATE_SCHEMA,
    "meta.json": VIEW_TEMPLATE_META,
}


# ---------------------------------------------------------------------------
# webapp_template (new-mode) seed helpers
# ---------------------------------------------------------------------------

def _ignore_backend(src: str, names: list[str]) -> list[str]:
    """copytree filter — when copying the template root, drop only the
    top-level `backend/` directory. Subdirectories named `backend` deeper
    in the tree (none today, but defensively scoped) are unaffected."""
    if os.path.abspath(src) == os.path.abspath(WEBAPP_TEMPLATE_DIR):
        return [n for n in names if n == "backend"]
    return []


_DEBUGGER_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "debugger")
)
_TEMPLATE_BACKEND_PATH = os.path.abspath(os.path.join(WEBAPP_TEMPLATE_DIR, "backend"))


def _patch_env_port(env_path: str, key: str, value: str) -> None:
    """Idempotent in-place rewrite: `KEY=...` → `KEY=value`. Appends if
    the key isn't present. Preserves surrounding lines untouched."""
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        text = f.read()
    pat = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    new_line = f"{key}={value}"
    if pat.search(text):
        text = pat.sub(new_line, text)
    else:
        if text and not text.endswith("\n"):
            text += "\n"
        text += new_line + "\n"
    with open(env_path, "w", encoding="utf-8") as f:
        f.write(text)


def seed_webapp_template_workspace(workspace_dir: str, frontend_port: int) -> None:
    """Copy the vendored webapp-template snapshot into `workspace_dir`,
    excluding the master template's `backend/` (brought in on-demand by
    the workspace's own `backend_init.sh`). Then:

      1. Copy `.env.example` → `.env` verbatim (preserves the upstream
         defaults `FRONTEND_PORT=4949` and `BACKEND_PORT=NONE`).
      2. Sed both `.env` and `.env.example` to set `FRONTEND_PORT=<port>`.
         BACKEND_PORT stays NONE in both (per spec — the agent flips it
         via backend_init.sh when it needs a backend).
      3. Append two install-specific paths to `.env` ONLY (NOT
         `.env.example` — these are absolute paths on the current
         machine, not template defaults):
            OPENSWARM_TEMPLATE_BACKEND_PATH=<abs path to master template's backend/>
            OPENSWARM_DEBUGGER_PATH=<abs path to OpenSwarm's debugger/ package>
         The first is read by `backend_init.sh`; the second is read by
         the template's `backend/run.sh` to install our local debugger
         before `pip install -e .`.

    Idempotent within reason — re-running over an existing workspace
    overwrites template files and re-asserts the env values.
    """
    os.makedirs(workspace_dir, exist_ok=True)
    shutil.copytree(
        WEBAPP_TEMPLATE_DIR,
        workspace_dir,
        ignore=_ignore_backend,
        dirs_exist_ok=True,
    )
    env_path = os.path.join(workspace_dir, ".env")
    env_example_path = os.path.join(workspace_dir, ".env.example")
    src_example = os.path.join(WEBAPP_TEMPLATE_DIR, ".env.example")
    if os.path.exists(src_example):
        shutil.copyfile(src_example, env_path)

    _patch_env_port(env_path, "FRONTEND_PORT", str(frontend_port))
    _patch_env_port(env_example_path, "FRONTEND_PORT", str(frontend_port))

    # Install-specific paths — .env only.
    _patch_env_port(env_path, "OPENSWARM_TEMPLATE_BACKEND_PATH", _TEMPLATE_BACKEND_PATH)
    _patch_env_port(env_path, "OPENSWARM_DEBUGGER_PATH", _DEBUGGER_PATH)

    # Make the shipped scripts executable. tarball/git extracts may strip
    # the +x bit depending on how the snapshot was vendored.
    for script in ("run.sh", "backend_init.sh", "frontend/run.sh"):
        p = os.path.join(workspace_dir, script)
        if os.path.exists(p):
            os.chmod(p, 0o755)
