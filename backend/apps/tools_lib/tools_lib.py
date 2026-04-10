import asyncio
import json
import os
import re
import sys
import logging
import shutil
import time
from contextlib import asynccontextmanager
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import HTTPException, Query
from fastapi.responses import HTMLResponse
from backend.config.Apps import SubApp
from backend.apps.tools_lib.models import ToolDefinition, ToolCreate, ToolUpdate, BUILTIN_TOOLS

logger = logging.getLogger(__name__)

from backend.config.paths import BACKEND_DIR, DATA_ROOT, TOOLS_DIR as DATA_DIR, BUILTIN_PERMISSIONS_PATH as BUILTIN_PERMS_PATH

load_dotenv(os.path.join(BACKEND_DIR, ".env"))
if os.environ.get("OPENSWARM_PACKAGED") == "1":
    load_dotenv(os.path.join(os.path.dirname(DATA_ROOT), ".env"), override=True)


@asynccontextmanager
async def tools_lib_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    yield


tools_lib = SubApp("tools", tools_lib_lifespan)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/contacts.readonly",
]

_pending_oauth: dict[str, str] = {}


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
        return ToolDefinition(**json.load(f))


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


@tools_lib.router.get("/builtin/permissions")
async def get_builtin_permissions():
    return {"permissions": load_builtin_permissions()}


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


@tools_lib.router.get("/oauth/callback")
async def oauth_callback(code: str = Query(...), state: str = Query("")):
    tool_id = _pending_oauth.pop(state, None)
    if not tool_id:
        return HTMLResponse("<html><body><h2>Invalid OAuth state</h2></body></html>", status_code=400)

    tool = _load(tool_id)
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    _port = os.environ.get("OPENSWARM_PORT", "8324")
    redirect_uri = f"http://localhost:{_port}/api/tools/oauth/callback"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        })

    if resp.status_code != 200:
        logger.warning(f"OAuth token exchange failed: {resp.text}")
        return HTMLResponse(f"<html><body><h2>Token exchange failed</h2><pre>{resp.text}</pre></body></html>", status_code=400)

    tokens = resp.json()
    access_token = tokens.get("access_token", "")
    tool.oauth_tokens = {
        "access_token": access_token,
        "refresh_token": tokens.get("refresh_token", ""),
        "token_expiry": time.time() + tokens.get("expires_in", 3600),
    }
    tool.auth_status = "connected"

    if access_token:
        try:
            async with httpx.AsyncClient(timeout=10.0) as info_client:
                info_resp = await info_client.get(
                    GOOGLE_USERINFO_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            if info_resp.status_code == 200:
                tool.connected_account_email = info_resp.json().get("email")
        except Exception as e:
            logger.warning(f"Failed to fetch Google userinfo: {e}")

    _save(tool)

    return HTMLResponse("""
    <html><body>
    <h2 style="font-family:sans-serif;color:#22c55e">Connected successfully!</h2>
    <p style="font-family:sans-serif;color:#666">You can close this window.</p>
    <script>
      if (window.opener) window.opener.postMessage({type:'oauth_complete', tool_id:'""" + tool_id + """'}, '*');
      setTimeout(() => window.close(), 1500);
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


_XBIRD_CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".config", "xbird")
_XBIRD_CONFIG_PATH = os.path.join(_XBIRD_CONFIG_DIR, "config.json")


async def _fetch_twitter_screen_name(auth_token: str, ct0: str) -> str | None:
    """Fetch the logged-in Twitter/X screen name using session cookies."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.twitter.com/1.1/account/verify_credentials.json",
                headers={"x-csrf-token": ct0},
                cookies={"auth_token": auth_token, "ct0": ct0},
            )
        if resp.status_code == 200:
            screen_name = resp.json().get("screen_name")
            return f"@{screen_name}" if screen_name else None
    except Exception as e:
        logger.warning("Failed to fetch Twitter screen name: %s", e)
    return None


def _sync_external_config(tool: ToolDefinition):
    """Write credentials to external config files for tools that need them.

    xbird reads auth from ~/.config/xbird/config.json rather than env vars,
    so we sync credentials there when the user connects via the UI.
    """
    if tool.name == "xbird" and tool.credentials:
        auth_token = tool.credentials.get("TWITTER_AUTH_TOKEN", "")
        ct0 = tool.credentials.get("TWITTER_CT0", "")
        if auth_token and ct0:
            os.makedirs(_XBIRD_CONFIG_DIR, exist_ok=True)
            config = {}
            if os.path.exists(_XBIRD_CONFIG_PATH):
                try:
                    with open(_XBIRD_CONFIG_PATH) as f:
                        config = json.load(f)
                except Exception:
                    pass
            config["auth_token"] = auth_token
            config["ct0"] = ct0
            with open(_XBIRD_CONFIG_PATH, "w") as f:
                json.dump(config, f, indent=2)
            if sys.platform != "win32":
                os.chmod(_XBIRD_CONFIG_PATH, 0o600)
            logger.info("Synced xbird credentials to %s", _XBIRD_CONFIG_PATH)
    elif tool.name == "xbird" and not tool.credentials:
        if os.path.exists(_XBIRD_CONFIG_PATH):
            try:
                with open(_XBIRD_CONFIG_PATH) as f:
                    config = json.load(f)
                config.pop("auth_token", None)
                config.pop("ct0", None)
                with open(_XBIRD_CONFIG_PATH, "w") as f:
                    json.dump(config, f, indent=2)
                logger.info("Cleared xbird credentials from %s", _XBIRD_CONFIG_PATH)
            except Exception:
                pass


@tools_lib.router.put("/{tool_id}")
async def update_tool(tool_id: str, body: ToolUpdate):
    tool = _load(tool_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(tool, k, v)
    _sync_external_config(tool)

    if tool.name == "xbird" and tool.auth_status == "connected" and tool.credentials:
        auth_token = tool.credentials.get("TWITTER_AUTH_TOKEN", "")
        ct0 = tool.credentials.get("TWITTER_CT0", "")
        if auth_token and ct0:
            screen_name = await _fetch_twitter_screen_name(auth_token, ct0)
            if screen_name:
                tool.connected_account_email = screen_name

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

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", os.path.join(home, "AppData", "Roaming"))
        localappdata = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        dirs = [
            os.path.join(appdata, "npm"),
            os.path.join(home, ".cargo", "bin"),
            os.path.join(localappdata, "Programs", "Python"),
            os.path.join(home, "scoop", "shims"),
            os.path.join(home, ".bun", "bin"),
            os.path.join(home, ".volta", "bin"),
        ]
        # nvm-windows
        nvm_home = os.environ.get("NVM_HOME", "")
        if nvm_home and os.path.isdir(nvm_home):
            dirs.insert(0, os.environ.get("NVM_SYMLINK", nvm_home))
        return dirs

    dirs = [
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
    """Find a command on PATH, falling back to common user-local bin directories."""
    found = shutil.which(command)
    if found:
        return found
    for d in _extra_bin_dirs():
        candidate = os.path.join(d, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


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

    if tool.auth_type == "oauth2" and tool.oauth_tokens.get("access_token"):
        if config.get("type") in ("http", "sse"):
            headers = config.setdefault("headers", {})
            headers["Authorization"] = f"Bearer {tool.oauth_tokens['access_token']}"
        else:
            env = config.setdefault("env", {})
            env["OAUTH_ACCESS_TOKEN"] = tool.oauth_tokens["access_token"]
            if tool.oauth_tokens.get("refresh_token"):
                env["GOOGLE_WORKSPACE_REFRESH_TOKEN"] = tool.oauth_tokens["refresh_token"]
            client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
            client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
            if client_id:
                env["GOOGLE_WORKSPACE_CLIENT_ID"] = client_id
            if client_secret:
                env["GOOGLE_WORKSPACE_CLIENT_SECRET"] = client_secret

    if config.get("type") == "stdio":
        if config.get("command"):
            resolved = _resolve_command(config["command"])
            if resolved:
                config["command"] = resolved
        env = config.setdefault("env", {})
        env.setdefault("PATH", _augmented_path())
        env.setdefault("PYTHONPATH", "")

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
    # Reddit (before Twitter so "search_reddit" etc. don't mis-match)
    (["subreddit"], "Subreddits", "Reddit"),
    (["search_reddit"], "Search", "Reddit"),
    (["post_detail"], "Posts", "Reddit"),
    (["user_analysis"], "Users", "Reddit"),
    (["reddit_explain"], "Reference", "Reddit"),
    # Twitter / X
    (["tweet", "thread", "reply", "replies", "quote", "retweet", "article"], "Tweets", "Twitter"),
    (["timeline", "home", "news", "trending"], "Timeline", "Twitter"),
    (["follower", "following", "follow", "unfollow"], "Network", "Twitter"),
    (["like", "unlike", "bookmark"], "Engagement", "Twitter"),
    (["mention"], "Mentions", "Twitter"),
    (["user", "profile"], "Users", "Twitter"),
    (["media", "upload", "image", "video"], "Media", "Twitter"),
    (["search"], "Search", "Twitter"),
    (["list", "list_member"], "Lists", "Twitter"),
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


async def _discover_mcp_tools_stdio(command: str, args: list[str] | None = None, env: dict | None = None) -> list[dict]:
    """Spawn a stdio MCP server process and call tools/list via JSON-RPC over stdin/stdout."""
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
    )

    async def _send(msg: dict) -> None:
        line = json.dumps(msg) + "\n"
        proc.stdin.write(line.encode())
        await proc.stdin.drain()

    async def _recv() -> dict:
        """Read JSON-RPC responses, skipping notification lines (no 'id' field)."""
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=30.0)
            if not line:
                stderr_out = ""
                try:
                    stderr_out = (await asyncio.wait_for(proc.stderr.read(4096), timeout=2.0)).decode(errors="replace")
                except (asyncio.TimeoutError, Exception):
                    pass
                raise HTTPException(
                    status_code=502,
                    detail=f"MCP stdio process exited unexpectedly{': ' + stderr_out if stderr_out else ''}",
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
        await _recv()

        await _send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        await _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        data = await _recv()

        tools_list = data.get("result", {}).get("tools", [])
        return [{"name": t.get("name", ""), "description": t.get("description", ""), "inputSchema": t.get("inputSchema")} for t in tools_list]

    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="MCP stdio server timed out during discovery")
    finally:
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
        refreshed = await refresh_google_token(tool)
        if not refreshed and tool.oauth_tokens.get("access_token"):
            expiry = tool.oauth_tokens.get("token_expiry", 0)
            if time.time() >= expiry - 60:
                client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
                if not client_id:
                    raise HTTPException(
                        status_code=400,
                        detail="OAuth token expired and GOOGLE_OAUTH_CLIENT_ID is not set. "
                               "In the packaged app, create ~/.openswarm.env or "
                               "~/Library/Application Support/OpenSwarm/.env with your Google OAuth credentials.",
                    )
                raise HTTPException(
                    status_code=502,
                    detail="OAuth token expired and refresh failed. Try reconnecting Google.",
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


@tools_lib.router.post("/{tool_id}/oauth/disconnect")
async def oauth_disconnect(tool_id: str):
    """Clear OAuth tokens and reset auth status so the user can reconnect with a different account."""
    tool = _load(tool_id)
    access_token = tool.oauth_tokens.get("access_token")

    if access_token:
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


@tools_lib.router.post("/{tool_id}/oauth/start")
async def oauth_start(tool_id: str):
    _load(tool_id)
    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(status_code=400, detail="GOOGLE_OAUTH_CLIENT_ID not set in backend .env")

    _port = os.environ.get("OPENSWARM_PORT", "8324")
    redirect_uri = f"http://localhost:{_port}/api/tools/oauth/callback"
    state = tool_id

    _pending_oauth[state] = tool_id

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(GOOGLE_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    auth_url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return {"auth_url": auth_url}




async def refresh_google_token(tool: ToolDefinition) -> Optional[str]:
    """Refresh an expired Google OAuth token. Returns the fresh access_token or None."""
    if tool.auth_type != "oauth2":
        return None
    refresh_token = tool.oauth_tokens.get("refresh_token")
    if not refresh_token:
        return None
    expiry = tool.oauth_tokens.get("token_expiry", 0)
    if time.time() < expiry - 60:
        return tool.oauth_tokens.get("access_token")

    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return None

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(GOOGLE_TOKEN_URL, data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            })
        if resp.status_code == 200:
            data = resp.json()
            new_token = data["access_token"]
            tool.oauth_tokens["access_token"] = new_token
            tool.oauth_tokens["token_expiry"] = time.time() + data.get("expires_in", 3600)

            if not tool.connected_account_email:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as info_client:
                        info_resp = await info_client.get(
                            GOOGLE_USERINFO_URL,
                            headers={"Authorization": f"Bearer {new_token}"},
                        )
                    if info_resp.status_code == 200:
                        tool.connected_account_email = info_resp.json().get("email")
                except Exception:
                    pass

            _save(tool)
            return new_token
    except Exception as e:
        logger.warning(f"Google token refresh failed for tool {tool.id}: {e}")
    return None
