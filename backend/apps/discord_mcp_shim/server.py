"""Stdio MCP shim for the Discord integration.

Carries no credentials. Each tool call is forwarded as a small HTTPS
request that includes a per-install identifier (used for rate-limiting).
The shim refuses operations against guilds not in OPENSWARM_DISCORD_GUILD_IDS
(set at spawn time from the user's authorized guild list).

stdlib-only on purpose so the subprocess starts fast.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROXY_BASE = os.environ.get("OPENSWARM_OAUTH_BASE_URL", "https://api.openswarm.com").rstrip("/")
INSTALL_ID = os.environ.get("OPENSWARM_INSTALL_ID", "")
ALLOWED_GUILDS = set(
    g for g in (os.environ.get("OPENSWARM_DISCORD_GUILD_IDS", "") or "").split(",") if g
)


# -- MCP tool definitions (exposed to the agent) ---------------------------
# Names match the original mcp-discord surface so prompts that referenced
# `discord_send` etc. keep working. inputSchema deliberately matches what
# the original package documented.

TOOLS = [
    {
        "name": "discord_login",
        "description": "Verify the Discord bot helper is reachable. Returns the bot's joined guilds.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "discord_get_server_info",
        "description": "Get metadata for a Discord guild (server) the bot is a member of.",
        "inputSchema": {
            "type": "object",
            "properties": {"guild_id": {"type": "string"}},
            "required": ["guild_id"],
        },
    },
    {
        "name": "discord_list_channels",
        "description": "List all channels in a Discord guild.",
        "inputSchema": {
            "type": "object",
            "properties": {"guild_id": {"type": "string"}},
            "required": ["guild_id"],
        },
    },
    {
        "name": "discord_create_text_channel",
        "description": "Create a new text channel in a guild.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "guild_id": {"type": "string"},
                "name": {"type": "string"},
                "parent_id": {"type": "string", "description": "Optional category ID"},
                "topic": {"type": "string"},
            },
            "required": ["guild_id", "name"],
        },
    },
    {
        "name": "discord_create_category",
        "description": "Create a new category (parent) in a guild.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "guild_id": {"type": "string"},
                "name": {"type": "string"},
            },
            "required": ["guild_id", "name"],
        },
    },
    {
        "name": "discord_edit_category",
        "description": "Rename or modify a category channel.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "name": {"type": "string"},
            },
            "required": ["channel_id"],
        },
    },
    {
        "name": "discord_delete_category",
        "description": "Delete a category channel.",
        "inputSchema": {
            "type": "object",
            "properties": {"channel_id": {"type": "string"}},
            "required": ["channel_id"],
        },
    },
    {
        "name": "discord_delete_channel",
        "description": "Delete a channel by ID.",
        "inputSchema": {
            "type": "object",
            "properties": {"channel_id": {"type": "string"}},
            "required": ["channel_id"],
        },
    },
    {
        "name": "discord_send",
        "description": "Send a message to a Discord channel.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["channel_id", "content"],
        },
    },
    {
        "name": "discord_read_messages",
        "description": "Read recent messages from a Discord channel (most recent first).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "limit": {"type": "integer", "default": 50, "description": "1-100"},
            },
            "required": ["channel_id"],
        },
    },
    {
        "name": "discord_add_reaction",
        "description": "Add an emoji reaction to a message (as the bot).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "message_id": {"type": "string"},
                "emoji": {
                    "type": "string",
                    "description": "Unicode emoji (e.g. 👍) or name:id custom emoji",
                },
            },
            "required": ["channel_id", "message_id", "emoji"],
        },
    },
    {
        "name": "discord_add_multiple_reactions",
        "description": "Add multiple emoji reactions to a message.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "message_id": {"type": "string"},
                "emojis": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["channel_id", "message_id", "emojis"],
        },
    },
    {
        "name": "discord_get_forum_channels",
        "description": "List forum-type channels in a guild.",
        "inputSchema": {
            "type": "object",
            "properties": {"guild_id": {"type": "string"}},
            "required": ["guild_id"],
        },
    },
    {
        "name": "discord_create_forum_post",
        "description": "Create a forum thread/post in a forum channel.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "forum_id": {"type": "string"},
                "name": {"type": "string", "description": "Thread title"},
                "content": {"type": "string", "description": "First message body"},
            },
            "required": ["forum_id", "name", "content"],
        },
    },
    {
        "name": "discord_get_forum_post",
        "description": "Get a single message from a forum post.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "message_id": {"type": "string"},
            },
            "required": ["channel_id", "message_id"],
        },
    },
    {
        "name": "discord_reply_to_forum",
        "description": "Reply to a forum thread.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["channel_id", "content"],
        },
    },
]


# -- HTTP plumbing ---------------------------------------------------------

def _call(
    method: str,
    path: str,
    *,
    body: dict | None = None,
    query: dict | None = None,
    timeout: float = 30.0,
) -> tuple[int, dict | str]:
    """Single hop to the Discord helper service. Returns (status, parsed-body-or-text).

    install_id header attribution is mandatory server-side; if empty we fail
    locally so the user gets a clear error instead of an opaque 401.
    """
    if not INSTALL_ID:
        return 0, "OPENSWARM_INSTALL_ID env var not set; cannot call Discord proxy"

    url = f"{PROXY_BASE}/api/discord{path}"
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})

    headers = {
        "X-OpenSwarm-Install-Id": INSTALL_ID,
        "Accept": "application/json",
    }
    data: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(text) if text else {}
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as e:
        text = ""
        try:
            text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        except Exception:
            pass
        try:
            return e.code, json.loads(text) if text else {}
        except json.JSONDecodeError:
            return e.code, text or str(e)
    except urllib.error.URLError as e:
        return 0, f"Helper service unreachable: {e.reason}"
    except Exception as e:
        return 0, f"Request failed: {e!r}"


def _err(text: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}


def _ok(payload) -> dict:
    if isinstance(payload, str):
        return {"content": [{"type": "text", "text": payload}]}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, default=str)}]}


def _check_guild(guild_id: str) -> str | None:
    """Return an error string if guild_id is outside the user-authorized set, else None.

    The set is sourced from OPENSWARM_DISCORD_GUILD_IDS env var (CSV) which
    tools_lib.py populates from the tool's oauth_tokens.guilds. If the env
    var is empty (no guild authorization yet), allow all; agent shouldn't
    be able to spawn this MCP without an OAuth flow having happened.
    """
    if not ALLOWED_GUILDS:
        return None  # nothing to enforce yet
    if guild_id not in ALLOWED_GUILDS:
        return (
            f"Guild {guild_id} is not authorized for this OpenSwarm install. "
            f"Authorized guilds: {sorted(ALLOWED_GUILDS)}"
        )
    return None


# -- Tool implementations --------------------------------------------------

def handle_tool_call(name: str, args: dict) -> dict:
    if name == "discord_login":
        status, body = _call("GET", "/users/@me/guilds")
        if status != 200:
            return _err(f"Discord proxy unreachable (HTTP {status}): {body}")
        return _ok({"connected": True, "guilds": body})

    if name == "discord_get_server_info":
        gid = str(args.get("guild_id", ""))
        if (e := _check_guild(gid)): return _err(e)
        status, body = _call("GET", f"/guilds/{gid}")
        return _ok(body) if status == 200 else _err(f"HTTP {status}: {body}")

    if name == "discord_list_channels":
        gid = str(args.get("guild_id", ""))
        if (e := _check_guild(gid)): return _err(e)
        status, body = _call("GET", f"/guilds/{gid}/channels")
        return _ok(body) if status == 200 else _err(f"HTTP {status}: {body}")

    if name == "discord_create_text_channel":
        gid = str(args.get("guild_id", ""))
        if (e := _check_guild(gid)): return _err(e)
        payload: dict = {"name": args.get("name", ""), "type": 0}
        if args.get("parent_id"): payload["parent_id"] = args["parent_id"]
        if args.get("topic"): payload["topic"] = args["topic"]
        status, body = _call("POST", f"/guilds/{gid}/channels", body=payload)
        return _ok(body) if status in (200, 201) else _err(f"HTTP {status}: {body}")

    if name == "discord_create_category":
        gid = str(args.get("guild_id", ""))
        if (e := _check_guild(gid)): return _err(e)
        status, body = _call("POST", f"/guilds/{gid}/channels", body={"name": args.get("name", ""), "type": 4})
        return _ok(body) if status in (200, 201) else _err(f"HTTP {status}: {body}")

    if name == "discord_edit_category":
        cid = str(args.get("channel_id", ""))
        payload: dict = {}
        if args.get("name"): payload["name"] = args["name"]
        status, body = _call("PATCH", f"/channels/{cid}", body=payload)
        return _ok(body) if status == 200 else _err(f"HTTP {status}: {body}")

    if name == "discord_delete_category" or name == "discord_delete_channel":
        cid = str(args.get("channel_id", ""))
        status, body = _call("DELETE", f"/channels/{cid}")
        return _ok({"deleted": True}) if status in (200, 204) else _err(f"HTTP {status}: {body}")

    if name == "discord_send":
        cid = str(args.get("channel_id", ""))
        content = str(args.get("content", ""))
        status, body = _call("POST", f"/channels/{cid}/messages", body={"content": content})
        return _ok(body) if status in (200, 201) else _err(f"HTTP {status}: {body}")

    if name == "discord_read_messages":
        cid = str(args.get("channel_id", ""))
        limit = max(1, min(int(args.get("limit", 50) or 50), 100))
        status, body = _call("GET", f"/channels/{cid}/messages", query={"limit": limit})
        return _ok(body) if status == 200 else _err(f"HTTP {status}: {body}")

    if name == "discord_add_reaction":
        cid = str(args.get("channel_id", ""))
        mid = str(args.get("message_id", ""))
        emoji = str(args.get("emoji", ""))
        # Discord's URL needs the emoji urlencoded; passes through.
        status, body = _call("PUT", f"/channels/{cid}/messages/{mid}/reactions/{urllib.parse.quote(emoji, safe='')}/@me")
        return _ok({"added": emoji}) if status in (200, 204) else _err(f"HTTP {status}: {body}")

    if name == "discord_add_multiple_reactions":
        cid = str(args.get("channel_id", ""))
        mid = str(args.get("message_id", ""))
        emojis = args.get("emojis", []) or []
        results = []
        for e in emojis:
            status, body = _call("PUT", f"/channels/{cid}/messages/{mid}/reactions/{urllib.parse.quote(str(e), safe='')}/@me")
            results.append({"emoji": e, "ok": status in (200, 204), "status": status})
        return _ok({"reactions": results})

    if name == "discord_get_forum_channels":
        gid = str(args.get("guild_id", ""))
        if (e := _check_guild(gid)): return _err(e)
        status, body = _call("GET", f"/guilds/{gid}/channels")
        if status != 200: return _err(f"HTTP {status}: {body}")
        # Filter to type 15 (forum). Discord channel types reference:
        #   GUILD_FORUM = 15
        forums = [ch for ch in (body or []) if isinstance(ch, dict) and ch.get("type") == 15]
        return _ok(forums)

    if name == "discord_create_forum_post":
        fid = str(args.get("forum_id", ""))
        status, body = _call("POST", f"/channels/{fid}/threads", body={
            "name": args.get("name", ""),
            "message": {"content": args.get("content", "")},
        })
        return _ok(body) if status in (200, 201) else _err(f"HTTP {status}: {body}")

    if name == "discord_get_forum_post":
        cid = str(args.get("channel_id", ""))
        mid = str(args.get("message_id", ""))
        status, body = _call("GET", f"/channels/{cid}/messages/{mid}")
        return _ok(body) if status == 200 else _err(f"HTTP {status}: {body}")

    if name == "discord_reply_to_forum":
        cid = str(args.get("channel_id", ""))
        content = str(args.get("content", ""))
        status, body = _call("POST", f"/channels/{cid}/messages", body={"content": content})
        return _ok(body) if status in (200, 201) else _err(f"HTTP {status}: {body}")

    return _err(f"Unknown tool: {name}")


# -- JSON-RPC stdio loop ---------------------------------------------------

def _send(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        id_ = msg.get("id")
        params = msg.get("params", {}) or {}

        if method == "initialize":
            _send(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openswarm-discord", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            _send(id_, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name", "")
            args = params.get("arguments", {}) or {}
            try:
                _send(id_, handle_tool_call(name, args))
            except Exception as e:
                _send(id_, _err(f"shim crashed: {e!r}"))
        elif method == "ping":
            _send(id_, {})
        elif id_ is not None:
            _send(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
