import asyncio
import hashlib
import json
import os
import re
import logging
import shutil
import sys
import time
from contextlib import asynccontextmanager
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from backend.config.Apps import SubApp
from backend.apps.tools_lib.models import ToolDefinition, ToolCreate, ToolUpdate, BUILTIN_TOOLS

logger = logging.getLogger(__name__)

# Base URL for the OAuth helper service. Override via env in dev if needed.
OPENSWARM_OAUTH_BASE_URL = os.environ.get(
    "OPENSWARM_OAUTH_BASE_URL", "https://api.openswarm.com"
).rstrip("/")

from backend.config.paths import BACKEND_DIR, DATA_ROOT, TOOLS_DIR as DATA_DIR, BUILTIN_PERMISSIONS_PATH as BUILTIN_PERMS_PATH, TRUSTED_SENSITIVE_PATHS_PATH

load_dotenv(os.path.join(BACKEND_DIR, ".env"))
if os.environ.get("OPENSWARM_PACKAGED") == "1":
    load_dotenv(os.path.join(os.path.dirname(DATA_ROOT), ".env"), override=True)


@asynccontextmanager
async def tools_lib_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    _ensure_default_permissions()
    yield


tools_lib = SubApp("tools", tools_lib_lifespan)


# Bash defaults to "ask" because it can execute untrusted text from MCP tool
# outputs (Gmail, WebFetch); every other built-in is sandboxed by domain.
# Must match agent_manager._DEFAULTS so the Settings UI and the agent agree
# on what "no policy set" means.
_DEFAULT_BUILTIN_POLICIES = {"Bash": "ask"}


def _ensure_default_permissions() -> None:
    """Seed BUILTIN_PERMISSIONS_PATH so the user's Settings toggles persist
    cleanly. Without this the file is missing on first run, load returns {},
    every PUT-from-the-UI overwrites with the partial payload the click
    sent, and the user never sees their preferred policy stick. Idempotent:
    merges current defaults in for any tool missing from an existing file,
    never clobbers a policy the user already set.
    """
    existing = load_builtin_permissions()
    desired = {
        t.name: _DEFAULT_BUILTIN_POLICIES.get(t.name, "always_allow")
        for t in BUILTIN_TOOLS
    }
    merged = {**desired, **existing}
    if merged != existing:
        save_builtin_permissions(merged)

# All providers go through the Fly cloud-proxy claim handoff. The
# v1.0.28 local Google callback was retired in v1.0.29 once the prod
# Google OAuth client added the cloud's redirect URI.
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"


def _load_all() -> list[ToolDefinition]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(ToolDefinition(**json.load(f)))
    return result


def _save(tool: ToolDefinition):
    with open(os.path.join(DATA_DIR, f"{tool.id}.json"), "w") as f:
        json.dump(tool.model_dump(), f, indent=2)


def _load(tool_id: str) -> ToolDefinition:
    path = os.path.join(DATA_DIR, f"{tool_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Tool not found")
    with open(path) as f:
        tool = ToolDefinition(**json.load(f))
    # Migrate Discord tool configs from the old npx-based spawn (which
    # broke whenever the npx cache was partially populated) to the local
    # Python shim. Idempotent; if it's already on the shim, no-op.
    if (
        tool.name.lower() == "discord"
        and tool.mcp_config
        and tool.mcp_config.get("command") == "npx"
        and any("mcp-discord" in str(a) for a in (tool.mcp_config.get("args") or []))
    ):
        tool.mcp_config = {
            "type": "stdio",
            "command": "python",
            "args": ["-m", "backend.apps.discord_mcp_shim"],
        }
        _save(tool)
    return tool


@tools_lib.router.get("/builtin")
async def list_builtin_tools():
    return {"tools": [t.model_dump() for t in BUILTIN_TOOLS]}


def load_builtin_permissions() -> dict[str, str]:
    if not os.path.exists(BUILTIN_PERMS_PATH):
        return {}
    with open(BUILTIN_PERMS_PATH) as f:
        return json.load(f)


def save_builtin_permissions(perms: dict[str, str]):
    os.makedirs(os.path.dirname(BUILTIN_PERMS_PATH), exist_ok=True)
    with open(BUILTIN_PERMS_PATH, "w") as f:
        json.dump(perms, f, indent=2)


def load_trusted_sensitive_paths() -> list[str]:
    if not os.path.exists(TRUSTED_SENSITIVE_PATHS_PATH):
        return []
    try:
        with open(TRUSTED_SENSITIVE_PATHS_PATH) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    raw = data.get("patterns") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    return [p for p in raw if isinstance(p, str) and p]


def save_trusted_sensitive_paths(patterns: list[str]):
    os.makedirs(os.path.dirname(TRUSTED_SENSITIVE_PATHS_PATH), exist_ok=True)
    seen: list[str] = []
    for p in patterns:
        if isinstance(p, str) and p and p not in seen:
            seen.append(p)
    with open(TRUSTED_SENSITIVE_PATHS_PATH, "w") as f:
        json.dump({"patterns": seen}, f, indent=2)


@tools_lib.router.get("/builtin/permissions")
async def get_builtin_permissions():
    return {"permissions": load_builtin_permissions()}


@tools_lib.router.get("/trusted-sensitive-paths")
async def get_trusted_sensitive_paths():
    """Patterns the user has opted into always-allow for sensitive-path writes."""
    return {"patterns": load_trusted_sensitive_paths()}


@tools_lib.router.put("/trusted-sensitive-paths")
async def replace_trusted_sensitive_paths(body: dict):
    """Replace the full list; Settings page uses this to revoke entries."""
    incoming = body.get("patterns") or []
    if not isinstance(incoming, list):
        return {"patterns": load_trusted_sensitive_paths()}
    save_trusted_sensitive_paths([p for p in incoming if isinstance(p, str) and p])
    return {"patterns": load_trusted_sensitive_paths()}


@tools_lib.router.put("/builtin/permissions")
async def update_builtin_permissions(body: dict):
    valid_tools = {t.name for t in BUILTIN_TOOLS}
    valid_policies = {"always_allow", "ask", "deny"}
    perms = load_builtin_permissions()
    for name, policy in body.get("permissions", {}).items():
        if name in valid_tools and policy in valid_policies:
            perms[name] = policy
    save_builtin_permissions(perms)
    return {"permissions": perms}


@tools_lib.router.get("/list")
async def list_tools():
    return {"tools": [t.model_dump() for t in _load_all()]}


def _connected_html() -> HTMLResponse:
    """v1.0.25-style auto-close page. Same markup so the UX is unchanged."""
    return HTMLResponse("""
    <html><body>
    <h2 style="font-family:sans-serif;color:#22c55e">Connected successfully!</h2>
    <p style="font-family:sans-serif;color:#666">You can close this window.</p>
    <script>
      if (window.opener) window.opener.postMessage({type:'oauth_complete'}, '*');
      setTimeout(function(){ window.close(); }, 1500);
    </script>
    </body></html>
    """)


@tools_lib.router.get("/{tool_id}")
async def get_tool(tool_id: str):
    return _load(tool_id).model_dump()


@tools_lib.router.post("/create")
async def create_tool(body: ToolCreate):
    tool = ToolDefinition(
        name=body.name,
        description=body.description,
        command=body.command,
        mcp_config=body.mcp_config,
        credentials=body.credentials,
        auth_type=body.auth_type,
        auth_status=body.auth_status,
    )
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.put("/{tool_id}")
async def update_tool(tool_id: str, body: ToolUpdate):
    tool = _load(tool_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(tool, k, v)
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.delete("/{tool_id}")
async def delete_tool(tool_id: str):
    path = os.path.join(DATA_DIR, f"{tool_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


# ---------------------------------------------------------------------------
# MCP config derivation
# ---------------------------------------------------------------------------

def _sanitize_server_name(name: str) -> str:
    """Convert a tool name into a valid MCP server identifier (alphanumeric + hyphens)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    # Bundled uv-bin (ships uvx for non-dev users)
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    dirs = [
        os.path.join(_backend, "uv-bin"),
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".volta", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ]
    # nvm: pick the newest installed node version
    nvm_node = os.path.join(home, ".nvm", "versions", "node")
    try:
        if os.path.isdir(nvm_node):
            versions = sorted(os.listdir(nvm_node), reverse=True)
            if versions:
                dirs.insert(0, os.path.join(nvm_node, versions[0], "bin"))
    except OSError:
        pass
    # fnm
    fnm_bin = os.path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin")
    if os.path.isdir(fnm_bin):
        dirs.insert(0, fnm_bin)
    return dirs


def _resolve_command(command: str) -> str | None:
    """Find a command on PATH, falling back to common user-local bin directories
    and bundled binaries (uv-bin for uvx/uv)."""
    found = shutil.which(command)
    if found:
        return found
    # Windows binaries need an extension. shutil.which() handles PATHEXT for
    # PATH lookups, but we manually scan _extra_bin_dirs below; replicate
    # the suffix probing here so `uvx` finds `uvx.exe`, etc.
    if sys.platform == "win32":
        suffixes = [""] + os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").lower().split(os.pathsep)
    else:
        suffixes = [""]
    def _probe(directory: str) -> str | None:
        for suffix in suffixes:
            candidate = os.path.join(directory, command + suffix)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return None
    for d in _extra_bin_dirs():
        hit = _probe(d)
        if hit:
            return hit
    # Check bundled uv-bin directory (ships uv/uvx for non-dev users)
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return _probe(os.path.join(_backend, "uv-bin"))


def _augmented_path() -> str:
    """Return PATH with extra bin dirs prepended (for child process environments)."""
    extra = [d for d in _extra_bin_dirs() if os.path.isdir(d)]
    current = os.environ.get("PATH", "")
    seen: set[str] = set()
    parts: list[str] = []
    for p in extra + current.split(os.pathsep):
        if p and p not in seen:
            seen.add(p)
            parts.append(p)
    return os.pathsep.join(parts)


def derive_mcp_config(tool: ToolDefinition) -> Optional[dict]:
    """Build the claude_agent_sdk mcp_servers config entry for a tool.

    Returns None if the tool cannot be configured (e.g. missing data).
    """
    if not tool.mcp_config:
        return None

    config: dict = dict(tool.mcp_config)

    if tool.credentials:
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            for key, val in tool.credentials.items():
                if key.lower() in ("authorization", "api_key", "api-key"):
                    headers.setdefault("Authorization", f"Bearer {val}")
        else:
            env = config.setdefault("env", {})
            env.update(tool.credentials)

    if tool.oauth_tokens.get("access_token"):
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            headers["Authorization"] = f"Bearer {tool.oauth_tokens['access_token']}"
        else:
            env = config.setdefault("env", {})
            env["OAUTH_ACCESS_TOKEN"] = tool.oauth_tokens["access_token"]
            if tool.name.lower() == "notion":
                env["NOTION_TOKEN"] = tool.oauth_tokens["access_token"]
            if tool.name.lower() == "hubspot":
                env["PRIVATE_APP_ACCESS_TOKEN"] = tool.oauth_tokens["access_token"]
            if tool.oauth_tokens.get("refresh_token"):
                env["GOOGLE_WORKSPACE_REFRESH_TOKEN"] = tool.oauth_tokens["refresh_token"]
            # google_workspace_mcp's gauth.py hardcodes token_uri to
            # https://oauth2.googleapis.com/token and refreshes using the
            # local CLIENT_ID/SECRET on every API call. The OAuth flow
            # itself runs through the cloud's rotation pool, so the
            # refresh_token is bound to whichever pool slot minted it,
            # not the single client baked into the DMG. Mismatch -> Google
            # returns unauthorized_client. We point token_uri at a local
            # proxy that forwards the refresh to our cloud's pool-aware
            # /api/oauth/google/refresh endpoint; CLIENT_ID/SECRET become
            # unused placeholders (gauth.py only validates non-empty).
            _port = os.environ.get("OPENSWARM_PORT", "8324")
            env["GOOGLE_WORKSPACE_TOKEN_URI"] = (
                f"http://127.0.0.1:{_port}/api/tools/google-oauth-token"
            )
            env.setdefault("GOOGLE_WORKSPACE_CLIENT_ID", "openswarm-proxy")
            env.setdefault("GOOGLE_WORKSPACE_CLIENT_SECRET", "openswarm-proxy")

    # Google Workspace MCP: redirect spawn through our shim that
    # monkey-patches gauth.get_credentials before the worker registers
    # tools, so token_uri points at our local proxy. Stays a stdio
    # subprocess; google-workspace-mcp gets installed into uv's
    # ephemeral env via --with, same way the upstream entry-point
    # invocation used to do it.
    if tool.name.lower() == "google workspace" and config.get("type") == "stdio":
        shim_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "google_workspace_mcp_shim",
            "run.py",
        )
        config["command"] = "uv"
        config["args"] = ["run", "--with", "google-workspace-mcp", "python", shim_path]

    # Discord MCP runs as a small Python shim (backend.apps.discord_mcp_shim).
    # We pass install_id + base URL via env so the shim subprocess doesn't
    # need to import backend.config.* itself.
    if tool.name.lower() == "discord" and config.get("type") == "stdio":
        from backend.config.install_id import get_install_id
        env = config.setdefault("env", {})
        env["OPENSWARM_OAUTH_BASE_URL"] = OPENSWARM_OAUTH_BASE_URL
        env["OPENSWARM_INSTALL_ID"] = get_install_id()
        # Pass the authorized guild IDs so the shim can scope-enforce.
        guild_ids = [g.get("id", "") for g in (tool.oauth_tokens.get("guilds") or []) if g.get("id")]
        if guild_ids:
            env["OPENSWARM_DISCORD_GUILD_IDS"] = ",".join(guild_ids)
        # The shim runs as a subprocess and needs to import
        # `backend.apps.discord_mcp_shim`; set PYTHONPATH to the project
        # root (parent of the backend/ dir) so that import resolves.
        _project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        existing_pp = env.get("PYTHONPATH") or os.environ.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (_project_root + os.pathsep + existing_pp) if existing_pp else _project_root

    # Microsoft 365 MCP: use a stable token cache path shared across process spawns
    if tool.name.lower() == "microsoft 365" and config.get("type") == "stdio":
        env = config.setdefault("env", {})
        cache_dir = os.path.join(os.path.expanduser("~"), ".openswarm")
        os.makedirs(cache_dir, exist_ok=True)
        env["MS365_MCP_TOKEN_CACHE_PATH"] = os.path.join(cache_dir, "ms365-token-cache.json")
        env["MS365_MCP_SELECTED_ACCOUNT_PATH"] = os.path.join(cache_dir, "ms365-selected-account.json")

    if config.get("type") == "stdio":
        if config.get("command"):
            # `python` (no version suffix) doesn't exist on a stock macOS,
            # so a tool config that asks for "python" silently fails to
            # spawn; Claude Agent SDK then exposes zero tools from that
            # MCP. We resolve to the actual interpreter running the
            # backend (sys.executable), which is guaranteed to exist and
            # have backend modules importable. `python3` and absolute
            # paths pass through unchanged.
            if config["command"] == "python":
                resolved_python = sys.executable or shutil.which("python3") or shutil.which("python")
                if resolved_python:
                    config["command"] = resolved_python
            # Check for bundled npm MCP servers; use Electron's Node.js instead of npx
            if config["command"] in ("npx", "bunx"):
                pkg_name = next((a for a in (config.get("args") or []) if not a.startswith("-")), None)
                if pkg_name:
                    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                    electron_path = os.environ.get("OPENSWARM_ELECTRON_PATH")
                    # Two bundle layouts in mcp-bundles/, checked in priority order:
                    #
                    #  1. Multi-file bundle dir: mcp-bundles/<safe>/dist/index.js
                    #     Used when the SDK reads sibling files at runtime.
                    #     Examples: @softeria/ms-365-mcp-server reads
                    #     ../package.json for --version and dist/endpoints.json
                    #     for Graph API definitions; @notionhq/notion-mcp-server
                    #     reads ../scripts/notion-openapi.json. The build script
                    #     ships a stripped package.json (no "type":"module") next
                    #     to dist/ so __dirname/../package.json resolves correctly.
                    #     See scripts/build-app.sh `build_mcp_bundle_dir`.
                    #
                    #  2. Single-file bundle: mcp-bundles/<safe>.js
                    #     Used when the SDK is fully self-contained
                    #     (reddit-mcp-buddy).
                    #
                    # Scoped names get flattened ("@softeria/ms-365-mcp-server"
                    # -> "softeria-ms-365-mcp-server") for filesystem safety.
                    safe_bundle = pkg_name.replace("/", "-").replace("@", "")
                    bundle_dir_path = os.path.join(_backend, "mcp-bundles", safe_bundle, "dist", "index.js")
                    bundle_file_path = os.path.join(_backend, "mcp-bundles", f"{safe_bundle}.js")
                    bundle_path = None
                    if os.path.isfile(bundle_dir_path):
                        bundle_path = bundle_dir_path
                    elif os.path.isfile(bundle_file_path):
                        bundle_path = bundle_file_path
                    # Prefer the bundled real-Node binary over Electron-as-Node:
                    # avoids the bouncing "exec" Dock icon on fresh user Macs +
                    # spawns ~10x faster than re-execing the OpenSwarm Electron
                    # binary as Node. Falls back to Electron-as-Node only if
                    # the bundled node payload wasn't shipped (legacy builds).
                    bundled_node = os.environ.get("OPENSWARM_NODE_PATH")
                    if bundle_path and bundled_node and os.path.exists(bundled_node):
                        config["command"] = bundled_node
                        config["args"] = [bundle_path]
                        logger.info(f"Using bundled MCP server for {pkg_name} via bundled node ({bundle_path})")
                    elif bundle_path and electron_path:
                        config["command"] = electron_path
                        config["args"] = [bundle_path]
                        config.setdefault("env", {})["ELECTRON_RUN_AS_NODE"] = "1"
                        logger.info(f"Using bundled MCP server for {pkg_name} ({bundle_path})")
                    else:
                        # Check for pre-installed npm package (works in both dev and packaged modes)
                        safe_dir = pkg_name.replace("/", "-").replace("@", "")
                        npm_dir = os.path.join(_backend, "npm-servers", safe_dir)
                        pkg_json_path = os.path.join(npm_dir, "node_modules", pkg_name, "package.json")
                        if os.path.isfile(pkg_json_path):
                            import json as _json
                            with open(pkg_json_path) as f:
                                pkg_meta = _json.load(f)
                            bin_field = pkg_meta.get("bin", {})
                            entry = list(bin_field.values())[0] if isinstance(bin_field, dict) else bin_field
                            # Same priority as 9Router / MCP-bundle paths: bundled node > system node > Electron-as-Node.
                            node_cmd = (bundled_node if bundled_node and os.path.exists(bundled_node) else None) \
                                or shutil.which("node") \
                                or electron_path
                            if node_cmd:
                                config["command"] = node_cmd
                                config["args"] = [os.path.join(npm_dir, "node_modules", pkg_name, entry)]
                                if node_cmd == electron_path:
                                    config.setdefault("env", {})["ELECTRON_RUN_AS_NODE"] = "1"
                                logger.info(f"Using pre-installed npm MCP server for {pkg_name}")

            if not os.path.isabs(config.get("command", "")):
                resolved = _resolve_command(config["command"])
                if resolved:
                    config["command"] = resolved
                else:
                    logger.warning(f"Command '{config['command']}' not found on PATH or bundled directories")
        env = config.setdefault("env", {})
        env.setdefault("PATH", _augmented_path())
        env.setdefault("PYTHONPATH", "")
        # Point uv/uvx at our bundled Python; avoids macOS CLT popup on fresh Macs
        # and avoids downloading Python at runtime
        _is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"
        _is_windows = sys.platform == "win32"
        if _is_packaged:
            _resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
            if _is_windows:
                _bundled_python = os.path.join(_resources, "python-env", "python.exe")
            else:
                _bundled_python = os.path.join(_resources, "python-env", "bin", "python3")
            if os.path.exists(_bundled_python):
                env.setdefault("UV_PYTHON", _bundled_python)
        else:
            _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            if _is_windows:
                _venv_python = os.path.join(_backend, ".venv", "Scripts", "python.exe")
            else:
                _venv_python = os.path.join(_backend, ".venv", "bin", "python3")
            if os.path.exists(_venv_python):
                env.setdefault("UV_PYTHON", _venv_python)

    return config


# ---------------------------------------------------------------------------
# OAuth2 flow for Google Workspace (and other OAuth providers)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# MCP tool discovery
# ---------------------------------------------------------------------------

_READ_PREFIXES = ("get", "list", "read", "search", "fetch", "find", "query", "count", "check", "describe", "show", "download", "browse", "analy", "explain")
_WRITE_PREFIXES = ("create", "write", "delete", "update", "send", "remove", "modify", "add", "set", "put", "post", "patch", "insert", "move", "copy", "rename", "archive", "trash", "publish", "approve", "reject")


_SERVICE_RULES: list[tuple[list[str], str, str]] = [
    # (keywords, service_name, group)
    # Google Workspace
    (["gmail"], "Gmail", "Google"),
    (["drive"], "Drive", "Google"),
    (["calendar", "event", "freebusy"], "Calendar", "Google"),
    (["spreadsheet", "sheet"], "Sheets", "Google"),
    (["doc", "paragraph", "table"], "Docs", "Google"),
    (["chat", "space", "reaction", "message"], "Chat", "Google"),
    (["form", "publish_settings"], "Forms", "Google"),
    (["presentation", "slide", "page"], "Slides", "Google"),
    (["task_list", "task"], "Tasks", "Google"),
    (["contact"], "Contacts", "Google"),
    (["script", "deployment", "version", "trigger"], "Apps Script", "Google"),
    (["search_custom", "search_engine"], "Search", "Google"),
    # YouTube
    (["transcript", "caption"], "Transcripts", "YouTube"),
    (["video_detail", "video_comment", "video_categor", "video_engagement"], "Videos", "YouTube"),
    (["search_video", "trending_video"], "Search", "YouTube"),
    (["channel_stat", "channel_top"], "Channels", "YouTube"),
    # Reddit (before Twitter so "search_reddit" etc. don't mis-match)
    (["subreddit"], "Subreddits", "Reddit"),
    (["search_reddit"], "Search", "Reddit"),
    (["post_detail"], "Posts", "Reddit"),
    (["user_analysis"], "Users", "Reddit"),
    (["reddit_explain"], "Reference", "Reddit"),
]


def _categorize_tool(name: str) -> str:
    lower = name.lower().replace("_", " ").replace("-", " ").strip()
    for word in lower.split():
        for prefix in _READ_PREFIXES:
            if word.startswith(prefix):
                return "read"
        for prefix in _WRITE_PREFIXES:
            if word.startswith(prefix):
                return "write"
    return "write"


def _extract_service(name: str) -> tuple[str, str]:
    """Extract the service and group from a tool name (e.g. 'search_gmail_messages' -> ('Gmail', 'Google'))."""
    lower = name.lower()
    for keywords, display, group in _SERVICE_RULES:
        for kw in keywords:
            if kw in lower:
                return display, group
    return "Other", ""


def _parse_sse_json(text: str) -> dict | None:
    """Extract JSON from an SSE response body (handles `data: {...}` lines)."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("data:"):
            payload = stripped[len("data:"):].strip()
            if payload:
                try:
                    return json.loads(payload)
                except json.JSONDecodeError:
                    continue
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


async def _discover_mcp_tools_http(url: str, headers: dict | None = None) -> list[dict]:
    """Connect to a Streamable HTTP MCP server and call tools/list via JSON-RPC POST."""
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        **(headers or {}),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        init_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "self-swarm", "version": "0.1.0"}},
        })
        if init_resp.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"MCP initialize failed: {init_resp.status_code}")

        session_id = init_resp.headers.get("mcp-session-id", "")
        if session_id:
            h["mcp-session-id"] = session_id

        await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })

        list_resp = await client.post(url, headers=h, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        if list_resp.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"MCP tools/list failed: {list_resp.status_code}")

        ct = list_resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            data = _parse_sse_json(list_resp.text)
        else:
            data = list_resp.json()

        if not data:
            raise HTTPException(status_code=502, detail="Empty response from MCP server")

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]


async def _discover_mcp_tools_sse(url: str, headers: dict | None = None) -> list[dict]:
    """Connect to a legacy SSE MCP server (GET event-stream + POST messages) and call tools/list."""
    from mcp.client.sse import sse_client
    from mcp import ClientSession
    from mcp.types import Implementation

    try:
        async with sse_client(
            url=url,
            headers=headers,
            timeout=30,
            sse_read_timeout=30,
        ) as (read_stream, write_stream):
            async with ClientSession(
                read_stream,
                write_stream,
                client_info=Implementation(name="self-swarm", version="0.1.0"),
            ) as session:
                await session.initialize()
                result = await session.list_tools()
                return [{"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema if t.inputSchema else None} for t in result.tools]
    except BaseExceptionGroup as eg:
        first = eg.exceptions[0] if eg.exceptions else eg
        raise HTTPException(status_code=502, detail=f"SSE discovery failed: {first}") from first


_NPX_CACHE_RE = re.compile(r"_npx[/\\]([0-9a-f]{8,})[/\\]")


def _try_heal_npx_cache(stderr: str) -> str | None:
    """On `ERR_MODULE_NOT_FOUND` pointing into `~/.npm/_npx/<hash>/`, wipe that one dir.

    Why: interrupted npx installs leave a `package-lock.json` in the cache dir so
    subsequent spawns reuse a partially-extracted node_modules tree, which dies at
    import time. Scoped strictly to the extracted hash subdir; never touches
    anything outside `~/.npm/_npx/`.
    """
    if "ERR_MODULE_NOT_FOUND" not in stderr:
        return None
    m = _NPX_CACHE_RE.search(stderr)
    if not m:
        return None
    hash_ = m.group(1)
    cache_dir = os.path.join(os.path.expanduser("~"), ".npm", "_npx", hash_)
    if not os.path.isdir(cache_dir):
        return None
    logger.warning("Corrupted npx cache detected at %s; wiping and letting caller retry", cache_dir)
    shutil.rmtree(cache_dir, ignore_errors=True)
    return hash_


async def _discover_mcp_tools_stdio(command: str, args: list[str] | None = None, env: dict | None = None, _attempt: int = 0) -> list[dict]:
    """Spawn a stdio MCP server process and call tools/list via JSON-RPC over stdin/stdout.

    On the first attempt, a failure that looks like corrupted npx cache
    (`ERR_MODULE_NOT_FOUND` pointing into `~/.npm/_npx/<hash>/`) triggers one
    auto-heal + retry. No heal on `_attempt >= 1`.
    """
    cmd_path = _resolve_command(command)
    if not cmd_path:
        raise HTTPException(status_code=400, detail=f"Command '{command}' not found on PATH or common install locations")

    proc_env = {**os.environ, **(env or {}), "PATH": _augmented_path()}
    proc_env.pop("PYTHONPATH", None)

    proc = await asyncio.create_subprocess_exec(
        cmd_path, *(args or []),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=proc_env,
        limit=10 * 1024 * 1024,  # 10 MB buffer for large tool lists
    )

    # Drain stderr in the background. Two reasons: (1) the OS pipe buffer is
    # ~64 KB; if npx prints more than that during a cold-cache install
    # (which happens when AV scanning slows npm), the child blocks on
    # write and we'd see what looks like a hang. (2) the rolling tail lets
    # us include npx's own diagnostic in any error we surface, instead of
    # the opaque "discovery failed" we used to show.
    stderr_tail: list[str] = []

    async def _drain_stderr() -> None:
        try:
            while True:
                chunk = await proc.stderr.readline()
                if not chunk:
                    return
                stderr_tail.append(chunk.decode(errors="replace"))
                if len(stderr_tail) > 50:
                    del stderr_tail[: len(stderr_tail) - 50]
        except asyncio.CancelledError:
            return
        except Exception:
            return

    stderr_task = asyncio.create_task(_drain_stderr())

    async def _send(msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv(timeout_s: float = 30.0) -> dict:
        """Read JSON-RPC responses, skipping notification lines (no 'id' field)."""
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout_s)
            if not line:
                # stdout EOF = child exited. Wait briefly for the stderr
                # drain to catch up so we capture the real failure reason
                # (which often arrives a few ms after stdout closes).
                try:
                    await asyncio.wait_for(asyncio.shield(stderr_task), timeout=1.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    pass
                tail = "".join(stderr_tail[-10:]).strip()
                raise HTTPException(
                    status_code=502,
                    detail=f"MCP stdio process exited unexpectedly{': ' + tail if tail else ''}",
                )
            stripped = line.decode(errors="replace").strip()
            if not stripped:
                continue
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if "id" in data:
                return data

    try:
        await _send({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "self-swarm", "version": "0.1.0"},
            },
        })
        # First response is the slow one. On Windows with a cold npx cache,
        # `npx -y <pkg>` has to download the package + transitive deps and
        # AV-scan every file npm writes; total install time often exceeds
        # 60 s and occasionally pushes past 90 s. Subsequent reads run
        # against an already-running server and stay at the default 30 s.
        await _recv(timeout_s=120.0)

        await _send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        await _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        data = await _recv()

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]

    except HTTPException as e:
        # Heal-on-corrupt-npx-cache still triggers from the EOF branch,
        # which now includes the full stderr tail in `e.detail`; so the
        # ERR_MODULE_NOT_FOUND signature is still discoverable here.
        if _attempt == 0 and _try_heal_npx_cache(str(e.detail) if e.detail is not None else ""):
            return await _discover_mcp_tools_stdio(command, args, env, _attempt=1)
        raise
    except asyncio.TimeoutError:
        # Most common cause: cold npx cache on Windows. The npm install
        # persists across attempts, so a retry usually finishes against a
        # warm cache. Surface npx's own progress line if we have one; it
        # makes the cause obvious ("downloading X...") instead of opaque.
        tail_text = "".join(stderr_tail[-5:]).strip()
        detail = "MCP discovery timed out; the server may still be downloading on first run"
        if tail_text:
            preview = tail_text[-200:].replace("\n", " ").strip()
            detail += f" (last output: {preview})"
        detail += ". Try again in a moment."
        raise HTTPException(status_code=504, detail=detail)
    finally:
        stderr_task.cancel()
        try:
            await stderr_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


@tools_lib.router.post("/{tool_id}/discover")
async def discover_tools(tool_id: str):
    tool = _load(tool_id)

    if tool.auth_type == "oauth2" and tool.auth_status == "connected":
        if tool.oauth_tokens.get("refresh_token"):
            if tool.name.lower() == "airtable":
                refreshed = await refresh_airtable_token(tool)
            elif tool.name.lower() == "hubspot":
                refreshed = await refresh_hubspot_token(tool)
            else:
                refreshed = await refresh_google_token(tool)
            if not refreshed and tool.oauth_tokens.get("access_token"):
                expiry = tool.oauth_tokens.get("token_expiry", 0)
                if time.time() >= expiry - 60:
                    raise HTTPException(
                        status_code=502,
                        detail=f"OAuth token expired and refresh failed. Try reconnecting {tool.name}.",
                    )

    config = derive_mcp_config(tool)
    if not config:
        raise HTTPException(status_code=400, detail="Cannot derive MCP config for tool")

    transport = config.get("type", "")

    try:
        if transport == "stdio":
            command = config.get("command", "")
            if not command:
                raise HTTPException(status_code=400, detail="stdio transport requires a 'command' in MCP config")
            raw_tools = await _discover_mcp_tools_stdio(
                command=command,
                args=config.get("args"),
                env=config.get("env"),
            )
        elif transport in ("http", "sse") or config.get("url"):
            url = config.get("url", "")
            if not url:
                raise HTTPException(status_code=400, detail="HTTP/SSE transport requires a 'url' in MCP config")
            if transport == "sse":
                raw_tools = await _discover_mcp_tools_sse(url, config.get("headers"))
            else:
                try:
                    raw_tools = await _discover_mcp_tools_http(url, config.get("headers"))
                except HTTPException:
                    logger.info(f"Streamable HTTP failed for {tool.name}, retrying with SSE transport")
                    raw_tools = await _discover_mcp_tools_sse(url, config.get("headers"))
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported MCP transport type: '{transport}'. Use 'stdio', 'http', or 'sse'.")
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e).strip()
        if not msg:
            msg = type(e).__name__
        logger.warning(f"MCP tool discovery failed for {tool.name}: {msg}", exc_info=True)
        raise HTTPException(status_code=502, detail=f"Discovery failed: {msg}")

    services: dict[str, dict[str, list[str]]] = {}
    service_groups: dict[str, list[str]] = {}
    permissions: dict[str, Any] = {}

    for t in raw_tools:
        name = t["name"]
        cat = _categorize_tool(name)
        svc, group = _extract_service(name)
        if svc not in services:
            services[svc] = {"read": [], "write": []}
        services[svc][cat].append(name)
        permissions[name] = tool.tool_permissions.get(name, "ask")
        if group:
            service_groups.setdefault(group, [])
            if svc not in service_groups[group]:
                service_groups[group].append(svc)

    all_read = [n for s in services.values() for n in s["read"]]
    all_write = [n for s in services.values() for n in s["write"]]
    permissions["_categories"] = {"read": all_read, "write": all_write}
    permissions["_services"] = services
    permissions["_service_groups"] = service_groups
    permissions["_tool_descriptions"] = {t["name"]: t["description"] for t in raw_tools}
    permissions["_tool_schemas"] = {t["name"]: t.get("inputSchema") for t in raw_tools if t.get("inputSchema")}

    tool.tool_permissions = permissions
    _save(tool)

    return {"ok": True, "tool": tool.model_dump()}


# ---------------------------------------------------------------------------
# Microsoft 365 device-code login (runs in the backend, not the MCP server)
# ---------------------------------------------------------------------------

_m365_login_processes: dict[str, dict] = {}  # tool_id -> {proc, device_code, status, email}


def _m365_server_script() -> str:
    """Return the on-disk path to the bundled MS365 MCP server entry.

    v1.0.26 replaced the heavy backend/npm-servers/softeria-ms-365-mcp-server/
    node_modules tree (~93MB / 11k files) with a single esbuild bundle at
    backend/mcp-bundles/softeria-ms-365-mcp-server/dist/index.js (4.7MB).
    The new path mirrors the SDK's internal layout (dist/index.js + sibling
    package.json) because cli.js reads __dirname/../package.json for the
    --version flag; see scripts/build-app.sh `build_mcp_bundle_dir`.
    """
    _backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bundle = os.path.join(
        _backend, "mcp-bundles", "softeria-ms-365-mcp-server", "dist", "index.js",
    )
    if os.path.isfile(bundle):
        return bundle
    # Fallback for any user still on a v1.0.25 install whose backend/ folder
    # was left over from before the bundle migration. Will return the legacy
    # path; if that doesn't exist either, the caller raises a clear error.
    return os.path.join(
        _backend, "npm-servers", "softeria-ms-365-mcp-server",
        "node_modules", "@softeria", "ms-365-mcp-server", "dist", "index.js",
    )


def _m365_cache_env() -> dict[str, str]:
    cache_dir = os.path.join(os.path.expanduser("~"), ".openswarm")
    os.makedirs(cache_dir, exist_ok=True)
    return {
        "MS365_MCP_TOKEN_CACHE_PATH": os.path.join(cache_dir, "ms365-token-cache.json"),
        "MS365_MCP_SELECTED_ACCOUNT_PATH": os.path.join(cache_dir, "ms365-selected-account.json"),
    }


@tools_lib.router.post("/{tool_id}/m365/device-login")
async def m365_device_login(tool_id: str):
    """Start a Microsoft 365 device-code login.

    Spawns the MCP server with --login in a long-lived subprocess.
    Returns the device code and URL for the user to authenticate.
    """
    import subprocess

    tool = _load(tool_id)
    script = _m365_server_script()
    if not os.path.isfile(script):
        raise HTTPException(status_code=500, detail="M365 MCP server not installed")

    # Same priority as MCP-bundle / 9Router paths: bundled real node first
    # (clean, no Dock flicker, fast cold-start), then system node, then
    # Electron-as-Node as last resort.
    bundled = os.environ.get("OPENSWARM_NODE_PATH")
    node = shutil.which("node")
    electron = os.environ.get("OPENSWARM_ELECTRON_PATH")
    cmd = (bundled if bundled and os.path.exists(bundled) else None) or node or electron
    if not cmd:
        raise HTTPException(status_code=500, detail="No node/electron found")

    env = {**os.environ, **_m365_cache_env()}
    if cmd == electron:
        env["ELECTRON_RUN_AS_NODE"] = "1"

    # Kill any existing login process for this tool
    existing = _m365_login_processes.pop(tool_id, None)
    if existing and existing.get("proc"):
        try:
            existing["proc"].kill()
        except Exception:
            pass

    proc = subprocess.Popen(
        [cmd, script, "--login"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, text=True,
    )

    # Read stdout lines until we find the device code (MSAL prints it)
    import threading
    login_state: dict = {"proc": proc, "status": "waiting_for_code", "device_code": "", "device_code_url": "", "email": None, "output": ""}

    def _read_output():
        import re
        for line in proc.stdout:
            login_state["output"] += line
            # MSAL device code message contains the URL and code
            code_match = re.search(r'enter the code\s+(\S+)', line, re.IGNORECASE)
            url_match = re.search(r'(https://\S+)', line)
            if code_match:
                login_state["device_code"] = code_match.group(1)
                login_state["status"] = "awaiting_auth"
            if url_match and "microsoft" in url_match.group(1).lower():
                login_state["device_code_url"] = url_match.group(1)
        # Process ended; check result
        proc.wait()
        remaining_stderr = proc.stderr.read() if proc.stderr else ""
        login_state["output"] += remaining_stderr
        if proc.returncode == 0:
            login_state["status"] = "connected"
            # Try to extract email from output
            try:
                import json as _j
                result = _j.loads(login_state["output"].strip().split("\n")[-1])
                if result.get("success"):
                    ud = result.get("userData", {})
                    login_state["email"] = ud.get("userPrincipalName") or ud.get("displayName")
            except Exception:
                pass
            # Update tool status
            try:
                t = _load(tool_id)
                t.auth_status = "connected"
                if login_state.get("email"):
                    t.connected_account_email = login_state["email"]
                _save(t)
            except Exception:
                pass
        else:
            login_state["status"] = "error"

    thread = threading.Thread(target=_read_output, daemon=True)
    thread.start()

    _m365_login_processes[tool_id] = login_state

    # Wait briefly for device code to appear
    for _ in range(30):
        if login_state["device_code"]:
            break
        await asyncio.sleep(0.2)

    if not login_state["device_code"]:
        return {"status": "error", "message": "Timed out waiting for device code from MCP server"}

    return {
        "status": "awaiting_auth",
        "device_code": login_state["device_code"],
        "device_code_url": login_state["device_code_url"] or "https://login.microsoft.com/device",
    }


@tools_lib.router.get("/{tool_id}/m365/device-login/status")
async def m365_device_login_status(tool_id: str):
    """Poll the status of a pending M365 device-code login."""
    state = _m365_login_processes.get(tool_id)
    if not state:
        # Check if already connected via cached token
        cache_env = _m365_cache_env()
        cache_path = cache_env["MS365_MCP_TOKEN_CACHE_PATH"]
        if os.path.isfile(cache_path):
            tool = _load(tool_id)
            if tool.auth_status == "connected":
                return {"status": "connected", "email": tool.connected_account_email}
        return {"status": "no_login_in_progress"}

    status = state["status"]
    result: dict = {"status": status}
    if status == "connected":
        result["email"] = state.get("email")
        _m365_login_processes.pop(tool_id, None)
    elif status == "error":
        result["message"] = "Login failed"
        _m365_login_processes.pop(tool_id, None)

    return result


@tools_lib.router.post("/{tool_id}/m365/disconnect")
async def m365_disconnect(tool_id: str):
    """Disconnect M365 by clearing the cached token."""
    tool = _load(tool_id)
    cache_env = _m365_cache_env()
    for path in cache_env.values():
        if os.path.isfile(path):
            os.remove(path)
    tool.auth_status = "configured"
    tool.connected_account_email = None
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


@tools_lib.router.post("/{tool_id}/oauth/disconnect")
async def oauth_disconnect(tool_id: str):
    """Clear OAuth tokens and reset auth status so the user can reconnect with a different account."""
    tool = _load(tool_id)
    access_token = tool.oauth_tokens.get("access_token")

    if access_token and tool.name.lower() != "notion":
        # Revoke Google tokens
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    "https://oauth2.googleapis.com/revoke",
                    params={"token": access_token},
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
        except Exception as e:
            logger.warning(f"Failed to revoke Google token for tool {tool.id}: {e}")

    tool.oauth_tokens = {}
    tool.auth_status = "configured"
    tool.connected_account_email = None
    _save(tool)
    return {"ok": True, "tool": tool.model_dump()}


# Tool name → provider key for the OAuth helper service. All providers go
# through the Fly cloud-proxy so client_secret values never ship inside the
# desktop binary. v1.0.28 was the last release that used a local Google
# callback with the client_secret in backend/.env.
_TOOL_NAME_TO_PROVIDER = {
    "airtable": "airtable",
    "hubspot": "hubspot",
    "discord": "discord",
    "notion": "notion",
    # Built-in Google tool's name is "Google Workspace"; accept the bare
    # "google" alias too for forward compatibility.
    "google workspace": "google",
    "google": "google",
}


def _proxied_provider_for(tool: ToolDefinition) -> Optional[str]:
    return _TOOL_NAME_TO_PROVIDER.get(tool.name.lower())


@tools_lib.router.post("/{tool_id}/oauth/start")
async def oauth_start(tool_id: str):
    """Return the OAuth start URL for this tool. All built-in providers
    proxy through Fly so client_secret values stay server-side."""
    tool = _load(tool_id)
    proxied = _proxied_provider_for(tool)
    if not proxied:
        raise HTTPException(
            status_code=400,
            detail=f"No OAuth flow registered for tool '{tool.name}'.",
        )
    from backend.config.install_id import get_install_id
    install_id = get_install_id()
    _port = os.environ.get("OPENSWARM_PORT", "8324")
    params = {
        "install_id": install_id,
        "tool_id": tool_id,
        "local_port": _port,
    }
    auth_url = (
        f"{OPENSWARM_OAUTH_BASE_URL}/api/oauth/{proxied}/start?"
        f"{urlencode(params)}"
    )
    return {"auth_url": auth_url}


@tools_lib.router.get("/oauth/cloud-claim")
async def oauth_cloud_claim(
    session_id: str = Query(...),
    tool_id: str = Query(...),
):
    """Browser-facing callback for the proxied OAuth flow.

    Receives a single-use session_id, exchanges it for the tokens (using
    install_id as the binding), persists them, and serves an auto-close page.
    """
    from backend.config.install_id import get_install_id

    install_id = get_install_id()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{OPENSWARM_OAUTH_BASE_URL}/api/oauth/session/{session_id}/claim",
                json={"install_id": install_id},
            )
    except Exception as e:
        logger.exception("Cloud OAuth claim threw: %s", e)
        return HTMLResponse(
            f"<html><body><h2>Connection failed</h2><pre>{e}</pre>"
            f"<p>Please retry from OpenSwarm.</p></body></html>",
            status_code=502,
        )

    if resp.status_code in (404, 410):
        return HTMLResponse(
            "<html><body><h2>Session expired</h2>"
            "<p>Please retry from OpenSwarm.</p></body></html>",
            status_code=410,
        )
    if resp.status_code == 403:
        return HTMLResponse(
            "<html><body><h2>OAuth session not bound to this install</h2>"
            "<p>Please retry from OpenSwarm.</p></body></html>",
            status_code=403,
        )
    if resp.status_code != 200:
        logger.warning("Cloud OAuth claim failed: HTTP %d %s", resp.status_code, resp.text[:200])
        return HTMLResponse(
            f"<html><body><h2>Cloud OAuth claim failed</h2><pre>{resp.text}</pre></body></html>",
            status_code=502,
        )

    data = resp.json()
    tokens = data.get("tokens", {}) or {}
    tool = _load(tool_id)
    # Google's token endpoint doesn't include the user's email; fetch it
    # from userinfo so the UI can show "you connected ericzeng@gmail.com"
    # rather than the generic "Google account" placeholder.
    if tool.name.lower() == "google" and tokens.get("access_token") and not tokens.get("email"):
        try:
            async with httpx.AsyncClient(timeout=10.0) as info_client:
                info_resp = await info_client.get(
                    GOOGLE_USERINFO_URL,
                    headers={"Authorization": f"Bearer {tokens['access_token']}"},
                )
            if info_resp.status_code == 200:
                tokens["email"] = info_resp.json().get("email") or ""
        except Exception as e:
            logger.warning("Google userinfo lookup post-claim failed: %s", e)
    _persist_cloud_tokens(tool, tokens)
    _save(tool)
    return _connected_html()


def _persist_cloud_tokens(tool: ToolDefinition, tokens: dict) -> None:
    """Normalise the cloud's claim response into tool.oauth_tokens.

    Per-provider shaping mirrors what the v1.0.25 local-callback flow used
    to write; the rest of the app (refresh helpers, MCP env injection)
    expects exactly this shape.
    """
    name = tool.name.lower()
    if name == "discord":
        new_guilds = (tokens.get("_guilds") or []) if isinstance(tokens, dict) else []
        existing = tool.oauth_tokens.get("guilds") or []
        for g in new_guilds:
            if g.get("id") and not any(e.get("id") == g["id"] for e in existing):
                existing.append({"id": g["id"], "name": g.get("name", "")})
        tool.oauth_tokens = {"guilds": existing}
        names = ", ".join(g.get("name", "") for g in existing if g.get("name"))
        tool.connected_account_email = (
            f"{len(existing)} server{'s' if len(existing) != 1 else ''}"
            + (f" · {names}" if names else "")
        )
    elif name == "notion":
        tool.oauth_tokens = {"access_token": tokens.get("access_token", "")}
        tool.connected_account_email = tokens.get("workspace_name", "Notion workspace")
    else:
        tool.oauth_tokens = {
            "access_token": tokens.get("access_token", ""),
            "refresh_token": tokens.get("refresh_token", ""),
            "token_expiry": time.time() + (tokens.get("expires_in") or 3600),
        }
        tool.connected_account_email = (
            tokens.get("email")            # Google (post-userinfo enrichment)
            or tokens.get("hub_domain")    # HubSpot
            or tokens.get("workspace_name")
            or f"{tool.name} account"
        )
    tool.auth_type = "oauth2"
    tool.auth_status = "connected"


async def _refresh_via_proxy(provider: str, tool: ToolDefinition, default_expiry: int) -> Optional[str]:
    """Refresh an OAuth access_token by POSTing the refresh_token to the
    helper service. Per-provider wrappers below pass a default expires_in
    fallback for providers that don't return one.
    """
    if tool.auth_type != "oauth2":
        return None
    refresh_token = tool.oauth_tokens.get("refresh_token")
    if not refresh_token:
        return None
    expiry = tool.oauth_tokens.get("token_expiry", 0)
    if time.time() < expiry - 60:
        return tool.oauth_tokens.get("access_token")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{OPENSWARM_OAUTH_BASE_URL}/api/oauth/{provider}/refresh",
                json={"refresh_token": refresh_token},
            )
        if resp.status_code == 401:
            # Provider rejected; user revoked at the provider's side. Mark
            # as needing re-auth so the UI prompts a Reconnect.
            tool.auth_status = "expired"
            _save(tool)
            logger.warning(f"{provider} refresh rejected (user revoked); marking tool as expired")
            return None
        if resp.status_code != 200:
            logger.warning(f"{provider} cloud refresh failed: HTTP %d %s", resp.status_code, resp.text[:200])
            return None

        data = (resp.json() or {}).get("tokens") or {}
        new_token = data.get("access_token", "")
        if not new_token:
            return None
        tool.oauth_tokens["access_token"] = new_token
        tool.oauth_tokens["token_expiry"] = time.time() + (data.get("expires_in") or default_expiry)
        if data.get("refresh_token"):
            # Some providers (HubSpot, Airtable) rotate refresh_tokens on every
            # refresh. Persist the new one or future refreshes will fail.
            tool.oauth_tokens["refresh_token"] = data["refresh_token"]
        # Backfill identity label on first successful refresh after upgrade.
        if not tool.connected_account_email and data.get("email"):
            tool.connected_account_email = data["email"]
        _save(tool)
        return new_token
    except Exception as e:
        logger.warning(f"{provider} cloud refresh exception for tool {tool.id}: {e}")
        return None


async def refresh_google_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired Google access_token via the Fly cloud-proxy.

    The client_secret never leaves Fly; desktop only POSTs the
    refresh_token. Same pattern as Airtable/HubSpot. Pre-v1.0.29 builds
    held the secret in their bundled .env; v1.0.29 removed it.
    """
    return await _refresh_via_proxy("google", tool, default_expiry=3600)


async def refresh_airtable_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired Airtable OAuth access_token."""
    return await _refresh_via_proxy("airtable", tool, default_expiry=7200)


async def refresh_hubspot_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired HubSpot OAuth access_token."""
    return await _refresh_via_proxy("hubspot", tool, default_expiry=1800)


@tools_lib.router.post("/google-oauth-token")
async def google_oauth_token_proxy(request: Request):
    """Local mimic of Google's OAuth2 token endpoint for the
    google-workspace-mcp subprocess.

    google-workspace-mcp's google-auth library posts form-encoded
    {grant_type, refresh_token, client_id, client_secret} on every
    expired-token refresh. Because OAuth runs through a cloud-side
    rotation pool, the local CLIENT_ID/SECRET don't match the pool slot
    that minted the refresh_token, so a direct refresh against Google
    returns unauthorized_client. We accept the form-encoded shape,
    discard the (mismatched) local client creds, and forward the
    refresh_token to api.openswarm.com/api/oauth/google/refresh which
    walks the pool to find the issuing slot. The cloud's JSON envelope
    is reshaped back to Google's native token-endpoint response so
    google-auth keeps working transparently.
    """
    form = await request.form()
    grant_type = form.get("grant_type") or ""
    refresh_token = form.get("refresh_token") or ""
    if grant_type != "refresh_token" or not refresh_token:
        return Response(
            content='{"error":"unsupported_grant_type"}',
            status_code=400,
            media_type="application/json",
        )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            upstream = await client.post(
                f"{OPENSWARM_OAUTH_BASE_URL}/api/oauth/google/refresh",
                json={"refresh_token": refresh_token},
            )
    except Exception as e:
        return Response(
            content=f'{{"error":"upstream_unreachable","error_description":"{e}"}}',
            status_code=502,
            media_type="application/json",
        )
    if upstream.status_code != 200:
        return Response(
            content=upstream.text,
            status_code=upstream.status_code,
            media_type="application/json",
        )
    tokens = (upstream.json() or {}).get("tokens") or {}
    return Response(
        content=json.dumps({
            "access_token": tokens.get("access_token", ""),
            "expires_in": tokens.get("expires_in", 3600),
            "scope": tokens.get("scope", ""),
            "token_type": tokens.get("token_type", "Bearer"),
        }),
        status_code=200,
        media_type="application/json",
    )
