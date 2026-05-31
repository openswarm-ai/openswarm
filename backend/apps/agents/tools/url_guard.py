"""SSRF guard for the WebFetch tool.

The agent picks which URL to fetch, and that choice can be steered by
content on pages it already read (prompt injection). So every fetch URL,
and every redirect hop, is treated as hostile: only http(s), and never a
host that resolves to a private, loopback, link-local, or cloud-metadata
address. Redirects are followed manually so a public URL can't 30x-pivot
into the LAN behind our back.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

_ALLOWED_SCHEMES = ("http", "https")
_MAX_REDIRECTS = 5


class BlockedURLError(Exception):
    """Raised when a URL (or a redirect target) points somewhere unsafe."""


def _ip_is_blocked(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
        or not addr.is_global
    )


def _resolve_host(host: str) -> list[str]:
    """All A/AAAA records for host. A hostname can resolve to several IPs
    (round-robin, dual-stack); one bad one is enough to block."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise BlockedURLError(f"could not resolve host {host!r}") from exc
    return [info[4][0] for info in infos]


def validate_fetch_url(url: str) -> None:
    """Reject non-http(s) schemes and hosts that resolve to non-public IPs.

    A bare IP literal is checked directly; a hostname is resolved and every
    returned address must be public. Raises BlockedURLError otherwise.
    """
    parts = urlsplit(url)
    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise BlockedURLError(
            f"url scheme must be http or https (got {parts.scheme or 'none'!r})"
        )
    host = parts.hostname
    if not host:
        raise BlockedURLError("url has no host")

    # IP literal: check as-is so DNS rebinding can't sneak one past us.
    try:
        if _ip_is_blocked(str(ipaddress.ip_address(host))):
            raise BlockedURLError(f"host {host!r} resolves to a non-public address")
        return
    except ValueError:
        pass

    for ip in _resolve_host(host):
        if _ip_is_blocked(ip):
            raise BlockedURLError(f"host {host!r} resolves to a non-public address")


async def fetch_guarded(client, url: str):
    """GET `url` with manual redirect following, validating every hop.

    `client` must be an httpx.AsyncClient created with follow_redirects=False
    so this layer (not httpx) decides whether each Location is safe.
    """
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        validate_fetch_url(current)
        resp = await client.get(current)
        if resp.is_redirect and resp.headers.get("location"):
            current = str(resp.next_request.url) if resp.next_request else resp.headers["location"]
            continue
        return resp
    raise BlockedURLError(f"too many redirects fetching {url}")
