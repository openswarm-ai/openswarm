"""Custom OpenAI-compatible provider sync into 9Router.

9Router exposes arbitrary OpenAI-compatible endpoints via "provider nodes"
(POST /api/provider-nodes, type="openai-compatible"). A model_id of
<prefix>/<model> routes to that node's baseUrl. This module mirrors the
user's custom providers, the OpenAI passthrough lane, and OpenSwarm Pro
into those nodes. Talks to the already-running 9Router over HTTP; never
spawns the subprocess (that's process.py's job).
"""

import logging

from .process import NINE_ROUTER_API
from .sync import (
    NINE_ROUTER_CLAUDE_PRO_NAME,
    NINE_ROUTER_OPENAI_KEYED_PREFIX,
    _find_keyed_connection,
    _nr,
)

logger = logging.getLogger(__name__)

# We mirror settings.custom_providers[] with prefix `cp-<slug>` so they don't
# collide with the user's primary OpenAI key.
NINE_ROUTER_CUSTOM_NAME_SUFFIX = " (OpenSwarm-managed)"


async def _sync_openai_compat_node(api_key: str | None) -> None:
    """Create / update / delete the openai-compatible node + connection
    pair we use to ferry OpenAI requests through openai-passthrough."""
    if not _nr().is_running():
        return
    import os as _os
    port = _os.environ.get("OPENSWARM_PORT", "8324")
    base_url = f"http://127.0.0.1:{port}/api/openai-passthrough/v1"
    managed_name = f"OpenAI{NINE_ROUTER_CUSTOM_NAME_SUFFIX}"

    try:
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/provider-nodes")
            existing_nodes = (r.json().get("nodes") if r.status_code == 200 else []) or []
    except Exception as e:
        logger.warning(f"9Router OpenAI-compat node list failed: {e}")
        return
    existing_node = next(
        (n for n in existing_nodes if isinstance(n, dict) and n.get("prefix") == NINE_ROUTER_OPENAI_KEYED_PREFIX),
        None,
    )

    if not api_key:
        if existing_node:
            try:
                async with _nr().httpx.AsyncClient(timeout=5.0) as client:
                    await client.delete(f"{NINE_ROUTER_API}/provider-nodes/{existing_node['id']}")
                logger.info("9Router: removed OpenAI compat node (key cleared)")
            except Exception as e:
                logger.warning(f"9Router OpenAI compat delete failed: {e}")
        return

    node_payload = {
        "name": managed_name,
        "prefix": NINE_ROUTER_OPENAI_KEYED_PREFIX,
        "apiType": "chat",
        "baseUrl": base_url,
        "type": "openai-compatible",
    }
    node_id: str | None = existing_node.get("id") if existing_node else None
    try:
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            if existing_node:
                await client.put(
                    f"{NINE_ROUTER_API}/provider-nodes/{existing_node['id']}",
                    json=node_payload,
                )
                logger.info(f"9Router: updated OpenAI compat node {NINE_ROUTER_OPENAI_KEYED_PREFIX}")
            else:
                r = await client.post(
                    f"{NINE_ROUTER_API}/provider-nodes", json=node_payload,
                )
                if r.status_code >= 300:
                    logger.warning(
                        f"9Router: failed to create OpenAI compat node: "
                        f"{r.status_code} {r.text[:200]}"
                    )
                    return
                node_id = (r.json() or {}).get("node", {}).get("id")
                if not node_id:
                    return
                logger.info(f"9Router: created OpenAI compat node {NINE_ROUTER_OPENAI_KEYED_PREFIX} ({node_id})")
    except Exception as e:
        logger.warning(f"9Router OpenAI compat node sync failed: {e}")
        return

    try:
        existing_conn = await _find_keyed_connection(node_id, managed_name)
        conn_payload = {
            "provider": node_id,
            "authType": "apikey",
            "name": managed_name,
            "apiKey": api_key,
            "priority": 0,
        }
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            if existing_conn:
                await client.patch(
                    f"{NINE_ROUTER_API}/providers/{existing_conn['id']}",
                    json=conn_payload,
                )
            else:
                r = await client.post(f"{NINE_ROUTER_API}/providers", json=conn_payload)
                if r.status_code >= 300:
                    logger.warning(
                        f"9Router: failed to create OpenAI compat connection: "
                        f"{r.status_code} {r.text[:200]}"
                    )
    except Exception as e:
        logger.warning(f"9Router OpenAI compat connection sync failed: {e}")


def _custom_provider_slug(name: str) -> str:
    """Slugify a user-supplied custom-provider name for use as a 9Router prefix.
    Always returns a non-empty alnum-and-dash string."""
    import re
    s = re.sub(r"[^a-zA-Z0-9-]+", "-", (name or "").strip().lower()).strip("-")
    return s or "custom"


def normalize_openai_compat_base_url(url: str) -> str:
    """Append `/v1` when the user supplied a host without an API path.

    9Router forwards openai-compatible nodes to `<baseUrl>/chat/completions`
    verbatim. Ollama, LM Studio, llama.cpp, vLLM, and every other OpenAI-
    compatible server exposes the API under `/v1`, so a user pasting
    `http://host:11434` (which is what Ollama prints on launch) ends up
    routed to `/chat/completions` and 404s. Path-bearing URLs are left
    alone, so `https://api.together.xyz/v1`, `https://openrouter.ai/api/v1`,
    or anything custom is untouched.
    """
    from urllib.parse import urlparse
    s = (url or "").strip().rstrip("/")
    if not s:
        return s
    try:
        path = urlparse(s).path
    except Exception:
        return s
    if not path:
        return s + "/v1"
    return s


async def sync_custom_providers(providers: list) -> None:
    """Mirror settings.custom_providers into 9Router as openai-compatible nodes.

    Idempotent: existing managed nodes (identified by name suffix) are PUT-updated
    in place, missing ones are POST-created, and any managed node whose prefix is
    no longer in `providers` is deleted (which cascades to its connection).
    Silent no-op when 9Router isn't running.
    """
    if not _nr().is_running():
        return

    try:
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{NINE_ROUTER_API}/provider-nodes")
            existing_nodes = (r.json().get("nodes") if r.status_code == 200 else []) or []
    except Exception as e:
        logger.warning(f"9Router custom-provider node list failed: {e}")
        return

    managed = [
        n for n in existing_nodes
        if isinstance(n, dict)
        and isinstance(n.get("name"), str)
        and n["name"].endswith(NINE_ROUTER_CUSTOM_NAME_SUFFIX)
    ]
    managed_by_prefix = {n.get("prefix"): n for n in managed if n.get("prefix")}

    seen_prefixes: set[str] = set()
    for cp in providers or []:
        name = getattr(cp, "name", None) or (cp.get("name") if isinstance(cp, dict) else None) or ""
        base_url = getattr(cp, "base_url", None) or (cp.get("base_url") if isinstance(cp, dict) else None) or ""
        api_key = getattr(cp, "api_key", None) or (cp.get("api_key") if isinstance(cp, dict) else None) or ""
        if not name.strip() or not base_url.strip():
            continue
        # Local OpenAI-compat servers (LM Studio, Ollama, etc.) reject a blank
        # Bearer header even with auth disabled. Substitute a placeholder; real
        # auth deployments always have api_key set.
        api_key = api_key.strip() or "no-auth-required"
        slug = _custom_provider_slug(name)
        prefix = f"cp-{slug}"
        seen_prefixes.add(prefix)
        managed_name = f"{name.strip()}{NINE_ROUTER_CUSTOM_NAME_SUFFIX}"

        node = managed_by_prefix.get(prefix)
        node_payload = {
            "name": managed_name,
            "prefix": prefix,
            "apiType": "chat",
            "baseUrl": normalize_openai_compat_base_url(base_url),
            "type": "openai-compatible",
        }
        try:
            async with _nr().httpx.AsyncClient(timeout=5.0) as client:
                if node:
                    await client.put(
                        f"{NINE_ROUTER_API}/provider-nodes/{node['id']}",
                        json=node_payload,
                    )
                    node_id = node["id"]
                    logger.info(f"9Router: updated custom node {prefix}")
                else:
                    r = await client.post(
                        f"{NINE_ROUTER_API}/provider-nodes", json=node_payload,
                    )
                    if r.status_code >= 300:
                        logger.warning(
                            f"9Router: failed to create custom node {prefix}: "
                            f"{r.status_code} {r.text[:200]}"
                        )
                        continue
                    node_id = (r.json() or {}).get("node", {}).get("id")
                    if not node_id:
                        continue
                    logger.info(f"9Router: created custom node {prefix} ({node_id})")
        except Exception as e:
            logger.warning(f"9Router custom node {prefix} sync failed: {e}")
            continue

        try:
            existing_conn = await _find_keyed_connection(node_id, managed_name)
            conn_payload = {
                "provider": node_id,
                "authType": "apikey",
                "name": managed_name,
                "apiKey": api_key,
                "priority": 0,
            }
            async with _nr().httpx.AsyncClient(timeout=5.0) as client:
                if existing_conn:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing_conn['id']}",
                        json=conn_payload,
                    )
                else:
                    r = await client.post(
                        f"{NINE_ROUTER_API}/providers", json=conn_payload,
                    )
                    if r.status_code >= 300:
                        logger.warning(
                            f"9Router: failed to create custom connection {prefix}: "
                            f"{r.status_code} {r.text[:200]}"
                        )
        except Exception as e:
            logger.warning(f"9Router custom connection {prefix} sync failed: {e}")

    # Drop managed nodes no longer in settings; DELETE cascades to connections.
    for prefix, node in managed_by_prefix.items():
        if prefix in seen_prefixes:
            continue
        try:
            async with _nr().httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/provider-nodes/{node['id']}")
                logger.info(f"9Router: removed orphaned custom node {prefix}")
        except Exception as e:
            logger.warning(f"9Router custom node {prefix} delete failed: {e}")


async def sync_openswarm_pro_as_claude(bearer_token: str | None, proxy_url: str | None) -> None:
    """Register OpenSwarm Pro as a `claude` apikey connection in 9Router,
    pointing at our cloud proxy via `providerSpecificData.baseUrl`.

    This is what makes the CLI's built-in WebSearch work on non-Claude
    primaries for Pro users: the CLI delegates the search execution to
    Anthropic via ANTHROPIC_SMALL_FAST_MODEL (claude-haiku). That small-
    model call hits `ANTHROPIC_BASE_URL` which we've already set to
    localhost:20128 (9Router). Without this sync, 9Router has no Claude
    path for openswarm-pro users, so the search fails with
    "no credentials for provider: claude". With this sync, 9Router sees
    the OpenSwarm-Pro-backed Claude connection and routes the search
    call through our cloud; same quota the user's Pro subscription
    already covers, no extra cost."""
    if not _nr().is_running():
        return

    # 9Router's POST /api/providers only accepts direct-API provider ids
    # for apikey auth; `claude` is the subscription/IDE id, `anthropic`
    # is the direct-API id. Use `anthropic`.
    existing = await _find_keyed_connection("anthropic", NINE_ROUTER_CLAUDE_PRO_NAME)
    try:
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            if bearer_token and proxy_url:
                payload = {
                    "provider": "anthropic",
                    "authType": "apikey",
                    "name": NINE_ROUTER_CLAUDE_PRO_NAME,
                    "apiKey": bearer_token,
                    # Priority 1 so a real user-owned Claude subscription
                    # (priority 0) still takes precedence if they have one.
                    # Pro is the fallback, not the default.
                    "priority": 1,
                    "providerSpecificData": {
                        "baseUrl": proxy_url.rstrip("/") + "/v1",
                    },
                }
                if existing:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing['id']}",
                        json=payload,
                    )
                    logger.info("9Router: updated OpenSwarm Pro → Claude connection")
                else:
                    r = await client.post(f"{NINE_ROUTER_API}/providers", json=payload)
                    if r.status_code < 300:
                        logger.info("9Router: created OpenSwarm Pro → Claude connection")
                    else:
                        logger.warning(
                            f"9Router: failed to create OpenSwarm Pro → Claude connection: {r.status_code} {r.text[:200]}"
                        )
            else:
                if existing:
                    await client.delete(f"{NINE_ROUTER_API}/providers/{existing['id']}")
                    logger.info("9Router: removed OpenSwarm Pro → Claude connection")
    except Exception as e:
        logger.warning(f"9Router OpenSwarm-Pro Claude sync failed: {e}")
