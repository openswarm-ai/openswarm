import logging
import os
import re
import shutil
import sys
from typing import Optional

from backend.apps.tools_lib.models import ToolDefinition
from backend.apps.tools_lib.oauth_config import OPENSWARM_OAUTH_BASE_URL

logger = logging.getLogger(__name__)


def sanitize_server_name(name: str) -> str:
    """Convert a tool name into a valid MCP server identifier (alphanumeric + hyphens)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def p_extra_bin_dirs() -> list[str]:
    """Well-known user-local bin directories that may not be on PATH in packaged apps."""
    home = os.path.expanduser("~")
    # Bundled uv-bin (ships uvx for non-dev users)
    p_backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    dirs = [
        os.path.join(p_backend, "uv-bin"),
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


def resolve_command(command: str) -> str | None:
    """Find a command on PATH, falling back to common user-local bin directories
    and bundled binaries (uv-bin for uvx/uv)."""
    found = shutil.which(command)
    if found:
        return found
    # Windows binaries need an extension. shutil.which() handles PATHEXT for PATH lookups, but we manually scan p_extra_bin_dirs below; replicate the suffix probing here so `uvx` finds `uvx.exe`, etc.
    if sys.platform == "win32":
        suffixes = [""] + os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").lower().split(os.pathsep)
    else:
        suffixes = [""]
    def p_probe(directory: str) -> str | None:
        for suffix in suffixes:
            candidate = os.path.join(directory, command + suffix)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        return None
    for d in p_extra_bin_dirs():
        hit = p_probe(d)
        if hit:
            return hit
    # Check bundled uv-bin directory (ships uv/uvx for non-dev users)
    p_backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return p_probe(os.path.join(p_backend, "uv-bin"))


def augmented_path() -> str:
    """Return PATH with extra bin dirs prepended (for child process environments)."""
    extra = [d for d in p_extra_bin_dirs() if os.path.isdir(d)]
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
            # google_workspace_mcp's gauth.py hardcodes token_uri to https://oauth2.googleapis.com/token and refreshes using the local CLIENT_ID/SECRET on every API call. The OAuth flow itself runs through the cloud's rotation pool, so the refresh_token is bound to whichever pool slot minted it, not the single client baked into the DMG. Mismatch -> Google returns unauthorized_client. We point token_uri at a local proxy that forwards the refresh to our cloud's pool-aware /api/oauth/google/refresh endpoint; CLIENT_ID/SECRET become unused placeholders (gauth.py only validates non-empty).
            p_port = os.environ.get("OPENSWARM_PORT", "8324")
            env["GOOGLE_WORKSPACE_TOKEN_URI"] = (
                f"http://127.0.0.1:{p_port}/api/tools/google-oauth-token"
            )
            env.setdefault("GOOGLE_WORKSPACE_CLIENT_ID", "openswarm-proxy")
            env.setdefault("GOOGLE_WORKSPACE_CLIENT_SECRET", "openswarm-proxy")

    # Google Workspace MCP: redirect spawn through our shim that monkey-patches gauth.get_credentials before the worker registers tools, so token_uri points at our local proxy. Stays a stdio subprocess; google-workspace-mcp gets installed into uv's ephemeral env via --with, same way the upstream entry-point invocation used to do it.
    if tool.name.lower() == "google workspace" and config.get("type") == "stdio":
        shim_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "google_workspace_mcp_shim",
            "run.py",
        )
        config["command"] = "uv"
        config["args"] = ["run", "--with", "google-workspace-mcp", "python", shim_path]

    # Discord MCP runs as a small Python shim (backend.apps.discord_mcp_shim). We pass install_id + base URL via env so the shim subprocess doesn't need to import backend.config.* itself.
    if tool.name.lower() == "discord" and config.get("type") == "stdio":
        from backend.config.install_id import get_install_id
        env = config.setdefault("env", {})
        env["OPENSWARM_OAUTH_BASE_URL"] = OPENSWARM_OAUTH_BASE_URL
        env["OPENSWARM_INSTALL_ID"] = get_install_id()
        # Pass the authorized guild IDs so the shim can scope-enforce.
        guild_ids = [g.get("id", "") for g in (tool.oauth_tokens.get("guilds") or []) if g.get("id")]
        if guild_ids:
            env["OPENSWARM_DISCORD_GUILD_IDS"] = ",".join(guild_ids)
        # The shim runs as a subprocess and needs to import `backend.apps.discord_mcp_shim`; set PYTHONPATH to the project root (parent of the backend/ dir) so that import resolves.
        p_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        existing_pp = env.get("PYTHONPATH") or os.environ.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (p_project_root + os.pathsep + existing_pp) if existing_pp else p_project_root

    # The session-borrow social shims (reddit/x/tiktok) each run as a Python shim that borrows the user's live browser session via the backend's cookie bridge, so they need the localhost port + auth token, plus PYTHONPATH to import themselves.
    if tool.name.lower() in {"reddit", "x", "tiktok"} and config.get("type") == "stdio":
        from backend.auth import get_auth_token
        env = config.setdefault("env", {})
        env["OPENSWARM_PORT"] = os.environ.get("OPENSWARM_PORT", "8324")
        env["OPENSWARM_AUTH_TOKEN"] = get_auth_token()
        p_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        existing_pp = env.get("PYTHONPATH") or os.environ.get("PYTHONPATH", "")
        env["PYTHONPATH"] = (p_project_root + os.pathsep + existing_pp) if existing_pp else p_project_root

    # Microsoft 365 MCP: use a stable token cache path shared across process spawns
    if tool.name.lower() == "microsoft 365" and config.get("type") == "stdio":
        env = config.setdefault("env", {})
        cache_dir = os.path.join(os.path.expanduser("~"), ".openswarm")
        os.makedirs(cache_dir, exist_ok=True)
        env["MS365_MCP_TOKEN_CACHE_PATH"] = os.path.join(cache_dir, "ms365-token-cache.json")
        env["MS365_MCP_SELECTED_ACCOUNT_PATH"] = os.path.join(cache_dir, "ms365-selected-account.json")

    if config.get("type") == "stdio":
        if config.get("command"):
            # `python` (no version suffix) doesn't exist on a stock macOS, so a tool config that asks for "python" silently fails to spawn; Claude Agent SDK then exposes zero tools from that MCP. We resolve to the actual interpreter running the backend (sys.executable), which is guaranteed to exist and have backend modules importable. `python3` and absolute paths pass through unchanged.
            if config["command"] == "python":
                resolved_python = sys.executable or shutil.which("python3") or shutil.which("python")
                if resolved_python:
                    config["command"] = resolved_python
            # Check for bundled npm MCP servers; use Electron's Node.js instead of npx
            if config["command"] in ("npx", "bunx"):
                pkg_name = next((a for a in (config.get("args") or []) if not a.startswith("-")), None)
                if pkg_name:
                    p_backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                    electron_path = os.environ.get("OPENSWARM_ELECTRON_PATH")
                    # Two bundle layouts in mcp-bundles/, checked in priority order: 1. Multi-file bundle dir: mcp-bundles/<safe>/dist/index.js Used when the SDK reads sibling files at runtime. Examples: @softeria/ms-365-mcp-server reads ../package.json for --version and dist/endpoints.json for Graph API definitions; @notionhq/notion-mcp-server reads ../scripts/notion-openapi.json. The build script ships a stripped package.json (no "type":"module") next to dist/ so __dirname/../package.json resolves correctly. See scripts/build-app.sh `build_mcp_bundle_dir`. 2. Single-file bundle: mcp-bundles/<safe>.js Used when the SDK is fully self-contained (reddit-mcp-buddy). Scoped names get flattened ("@softeria/ms-365-mcp-server" -> "softeria-ms-365-mcp-server") for filesystem safety.
                    safe_bundle = pkg_name.replace("/", "-").replace("@", "")
                    bundle_dir_path = os.path.join(p_backend, "mcp-bundles", safe_bundle, "dist", "index.js")
                    bundle_file_path = os.path.join(p_backend, "mcp-bundles", f"{safe_bundle}.js")
                    bundle_path = None
                    if os.path.isfile(bundle_dir_path):
                        bundle_path = bundle_dir_path
                    elif os.path.isfile(bundle_file_path):
                        bundle_path = bundle_file_path
                    # Prefer the bundled real-Node binary over Electron-as-Node: avoids the bouncing "exec" Dock icon on fresh user Macs + spawns ~10x faster than re-execing the OpenSwarm Electron binary as Node. Falls back to Electron-as-Node only if the bundled node payload wasn't shipped (legacy builds).
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
                        npm_dir = os.path.join(p_backend, "npm-servers", safe_dir)
                        pkg_json_path = os.path.join(npm_dir, "node_modules", pkg_name, "package.json")
                        if os.path.isfile(pkg_json_path):
                            import json as p_json
                            with open(pkg_json_path) as f:
                                pkg_meta = p_json.load(f)
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
                resolved = resolve_command(config["command"])
                if resolved:
                    config["command"] = resolved
                else:
                    logger.warning(f"Command '{config['command']}' not found on PATH or bundled directories")
        env = config.setdefault("env", {})
        env.setdefault("PATH", augmented_path())
        env.setdefault("PYTHONPATH", "")
        # Point uv/uvx at our bundled Python; avoids macOS CLT popup on fresh Macs and avoids downloading Python at runtime
        p_is_packaged = os.environ.get("OPENSWARM_PACKAGED") == "1"
        p_is_windows = sys.platform == "win32"
        if p_is_packaged:
            p_resources = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
            if p_is_windows:
                p_bundled_python = os.path.join(p_resources, "python-env", "python.exe")
            else:
                p_bundled_python = os.path.join(p_resources, "python-env", "bin", "python3")
            if os.path.exists(p_bundled_python):
                env.setdefault("UV_PYTHON", p_bundled_python)
        else:
            p_backend = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            if p_is_windows:
                p_venv_python = os.path.join(p_backend, ".venv", "Scripts", "python.exe")
            else:
                p_venv_python = os.path.join(p_backend, ".venv", "bin", "python3")
            if os.path.exists(p_venv_python):
                env.setdefault("UV_PYTHON", p_venv_python)

    return config
