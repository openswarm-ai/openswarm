import asyncio
import json
import logging
import os
import shutil
import time
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse
from backend.config.Apps import SubApp
from backend.apps.tools_lib.models import ToolDefinition, ToolCreate, ToolUpdate, BUILTIN_TOOLS
from backend.config.paths import DATA_ROOT, TOOLS_DIR as DATA_DIR, BUILTIN_PERMISSIONS_PATH as BUILTIN_PERMS_PATH, TRUSTED_SENSITIVE_PATHS_PATH

# oauth_config runs the dotenv load (leaf) so OPENSWARM_OAUTH_BASE_URL is set
# before anything reads it; re-exported here for the route handlers below.
from backend.apps.tools_lib.oauth_config import OPENSWARM_OAUTH_BASE_URL
# _sanitize_server_name + derive_mcp_config re-exported for agent_manager/main.
from backend.apps.tools_lib.mcp_config import _sanitize_server_name, derive_mcp_config
from backend.apps.tools_lib.mcp_discovery import (
    _discover_mcp_tools_http,
    _discover_mcp_tools_sse,
    _discover_mcp_tools_stdio,
)
from backend.apps.tools_lib.tool_taxonomy import _classify_services
# refresh_* re-exported for agent_manager.
from backend.apps.tools_lib.oauth_tokens import (
    _proxied_provider_for,
    _persist_cloud_tokens,
    refresh_google_token,
    refresh_airtable_token,
    refresh_hubspot_token,
    _m365_server_script,
    _m365_cache_env,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def tools_lib_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    _ensure_default_permissions()
    _reclassify_existing_tools()
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


def _reclassify_existing_tools() -> None:
    """One-time correction for tools discovered before service rules were integration-scoped: most
    integrations got mislabeled under a bogus 'Google' group (generic keyword rules applied globally).
    Recompute services/groups from each tool's stored tool names. Idempotent; rewrites only on change.
    """
    if not os.path.isdir(DATA_DIR):
        return
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            tool = _load(fname[:-5])
        except Exception:
            continue
        perms = tool.tool_permissions or {}
        if not perms.get("_services"):
            continue
        names = [k for k in perms if not k.startswith("_")]
        if not names:
            continue
        services, service_groups, all_read, all_write = _classify_services(names, tool.name)
        if perms.get("_services") == services and perms.get("_service_groups") == service_groups:
            continue
        perms["_services"] = services
        perms["_service_groups"] = service_groups
        perms["_categories"] = {"read": all_read, "write": all_write}
        tool.tool_permissions = perms
        try:
            _save(tool)
        except Exception:
            pass

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
    tools = []
    for t in _load_all():
        d = t.model_dump()
        # Heal pre-fix tools whose persisted email is the "{name} account" placeholder so the pill stops reading like a name and falls back to plain "Connected".
        placeholder = f"{t.name} account"
        if d.get("connected_account_email") == placeholder:
            d["connected_account_email"] = ""
        tools.append(d)
    return {"tools": tools}


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

    tool_names = [t["name"] for t in raw_tools]
    services, service_groups, all_read, all_write = _classify_services(tool_names, tool.name)
    permissions: dict[str, Any] = {n: tool.tool_permissions.get(n, "ask") for n in tool_names}
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
    if tool.name.lower().startswith("google") and tokens.get("access_token") and not tokens.get("email"):
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
