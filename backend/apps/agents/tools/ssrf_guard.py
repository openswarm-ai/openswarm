"""SSRF guard for the agent's web fetchers.

Blocks fetches that would target private/internal IPs (RFC1918, link-local
incl. cloud metadata, CGNAT, multicast, ULA v6, etc). Resolution is async
(non-blocking) and covers both IPv4 AND IPv6 via getaddrinfo.

Direct and IPv4-mapped loopback are allowed for desktop deployments because
App Builder previews servers on 127.0.0.1:<random> and the agent needs to
verify the built app actually runs. Hosted deployments block loopback, and
transition/local-use ranges never inherit the desktop exception.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
from urllib.parse import urljoin, urlparse

import httpx

from backend.apps.hosting.policy import hosting_policy

logger = logging.getLogger(__name__)


class SSRFBlocked(Exception):
    """A fetch was refused because it targets a forbidden IP range."""


class DomainUnreachable(SSRFBlocked):
    """The host has no DNS records at all: dead domain, typo, or no network.

    A subclass so every existing `except SSRFBlocked` still fails closed, but
    callers that care can tell "we refused this" apart from "this doesn't
    exist", which are opposite messages to show a user and have opposite
    fallbacks (nothing vs the archive)."""


# A page we will truncate to ~250KB anyway; without this a link to a disk image buffers the whole thing into RAM.
MAX_FETCH_BYTES = 10 * 1024 * 1024


P_BLOCKED_V4_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local incl. cloud metadata
    ipaddress.ip_network("100.64.0.0/10"),   # CGNAT
    ipaddress.ip_network("224.0.0.0/4"),     # multicast
    ipaddress.ip_network("240.0.0.0/4"),     # reserved + limited broadcast
    ipaddress.ip_network("0.0.0.0/8"),       # "this network"
    ipaddress.ip_network("198.18.0.0/15"),   # benchmarking
    ipaddress.ip_network("192.0.2.0/24"),    # TEST-NET-1
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),   # TEST-NET-3
]

P_BLOCKED_V6_NETS = [
    ipaddress.ip_network("fe80::/10"),       # link-local
    ipaddress.ip_network("fec0::/10"),       # deprecated site-local
    ipaddress.ip_network("fc00::/7"),        # ULA
    ipaddress.ip_network("64:ff9b:1::/48"),  # local-use NAT64
    ipaddress.ip_network("ff00::/8"),        # multicast
    ipaddress.ip_network("::/128"),          # unspecified
]
P_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")


async def p_resolve_host_async(host: str) -> list[str]:
    """Resolve host to all IPs (v4 + v6) without blocking the event loop."""
    loop = asyncio.get_event_loop()
    try:
        infos = await loop.getaddrinfo(host, None)
    except OSError as e:
        raise DomainUnreachable(f"{host} could not be resolved (dead domain, typo, or no network): {e}") from e
    return list({info[4][0] for info in infos})


def p_is_forbidden_ip(ip_str: str) -> bool:
    """True iff this IP is blocked for the current deployment."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # unparseable -> block

    if isinstance(ip, ipaddress.IPv4Address):
        if ip.is_loopback:
            return hosting_policy().blocks_loopback_targets()
        return any(ip in net for net in P_BLOCKED_V4_NETS)

    # Only direct v6 and v4-mapped loopback belong to desktop previews. Other
    # transition encodings must be judged as network targets, even when their
    # embedded v4 address is loopback.
    if ip.is_loopback:
        return hosting_policy().blocks_loopback_targets()
    mapped = ip.ipv4_mapped
    if mapped is not None:
        if mapped.is_loopback:
            return hosting_policy().blocks_loopback_targets()
        return any(mapped in net for net in P_BLOCKED_V4_NETS)

    if any(ip in net for net in P_BLOCKED_V6_NETS):
        return True

    embedded = ip.sixtofour
    if embedded is None and ip in P_NAT64_WELL_KNOWN:
        embedded = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if embedded is not None:
        if embedded.is_loopback:
            return True
        return any(embedded in net for net in P_BLOCKED_V4_NETS)
    return False


async def assert_safe_url(url: str) -> str:
    """Raise SSRFBlocked if url targets a forbidden range; otherwise return url.

    Resolves the host to ALL records (multi-A defense against single-record
    rebinding) and rejects if ANY resolution is private. Does not perfectly close
    DNS-rebinding TOCTOU (httpx resolves again on connect), but the agent-fetcher
    threat model on a desktop app is dominated by cloud-metadata and internal-LAN
    targets, not active rebinding attacks.
    """
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise SSRFBlocked(f"Unsupported URL scheme {scheme!r}; only http/https allowed.")
    host = parsed.hostname
    if not host:
        raise SSRFBlocked("URL has no hostname.")

    try:
        ipaddress.ip_address(host)
        if p_is_forbidden_ip(host):
            raise SSRFBlocked(f"URL host {host} is in a blocked range.")
        return url
    except ValueError:
        pass

    resolved = await p_resolve_host_async(host)
    if not resolved:
        raise DomainUnreachable(f"No DNS records for {host}.")
    for ip in resolved:
        if p_is_forbidden_ip(ip):
            raise SSRFBlocked(f"Host {host} resolves to forbidden IP {ip}.")
    return url


async def p_read_capped(client: httpx.AsyncClient, request: httpx.Request,
                        max_bytes: int) -> httpx.Response:
    """Send `request` and buffer at most `max_bytes` of the body.

    Returns a detached Response so callers keep the plain `.content` / `.text`
    interface. Content-Encoding and Content-Length are dropped because
    `aiter_bytes` already yields decoded bytes and the count may be short.
    """
    streamed = await client.send(request, stream=True)
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in streamed.aiter_bytes():
            chunks.append(chunk)
            total += len(chunk)
            if total >= max_bytes:
                break
    finally:
        await streamed.aclose()
    headers = httpx.Headers(
        [(k, v) for k, v in streamed.headers.multi_items()
         if k.lower() not in ("content-encoding", "content-length")]
    )
    return httpx.Response(status_code=streamed.status_code, headers=headers,
                          content=b"".join(chunks)[:max_bytes], request=request)


async def safe_fetch(
    url: str,
    *,
    method: str = "GET",
    headers: dict | None = None,
    timeout: float = 30.0,
    max_redirects: int = 5,
    json_body: dict | None = None,
    data: dict | None = None,
    max_bytes: int = MAX_FETCH_BYTES,
) -> httpx.Response:
    """Fetch with per-redirect SSRF re-validation.

    Manually walks the redirect chain so each hop's target host is re-checked,
    closing the per-redirect SSRF window that follow_redirects=True leaves open.
    """
    current_url = await assert_safe_url(url)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers or {}) as client:
        for _ in range(max_redirects + 1):
            req_kwargs: dict = {}
            if method.upper() == "POST":
                if json_body is not None:
                    req_kwargs["json"] = json_body
                if data is not None:
                    req_kwargs["data"] = data
            request = client.build_request(method.upper(), current_url, **req_kwargs)
            resp = await p_read_capped(client, request, max_bytes)
            if not (300 <= resp.status_code < 400):
                return resp
            location = resp.headers.get("location")
            if not location:
                return resp
            next_url = urljoin(current_url, location)
            current_url = await assert_safe_url(next_url)
    raise SSRFBlocked(f"Too many redirects (> {max_redirects}) starting from {url}.")
