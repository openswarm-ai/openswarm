"""SSRF guard: block fetches to private/internal IP ranges.

Resolves the target hostname to an IP address and rejects any URL whose
resolved address falls within loopback, LAN, link-local, or cloud-metadata
ranges (CVE class: CWE-918).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Private / reserved networks that must never be reachable via user URLs
# ---------------------------------------------------------------------------
_BLOCKED_NETWORKS: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = [
    ipaddress.ip_network("127.0.0.0/8"),       # IPv4 loopback
    ipaddress.ip_network("169.254.0.0/16"),    # link-local / cloud metadata (AWS IMDSv1, GCP, Azure)
    ipaddress.ip_network("10.0.0.0/8"),        # RFC-1918 private
    ipaddress.ip_network("172.16.0.0/12"),     # RFC-1918 private
    ipaddress.ip_network("192.168.0.0/16"),    # RFC-1918 private
    ipaddress.ip_network("100.64.0.0/10"),     # carrier-grade NAT (RFC 6598)
    ipaddress.ip_network("0.0.0.0/8"),         # "this" network
    ipaddress.ip_network("192.0.0.0/24"),      # IETF protocol assignments
    ipaddress.ip_network("198.18.0.0/15"),     # benchmarking (RFC 2544)
    ipaddress.ip_network("198.51.100.0/24"),   # TEST-NET-2 (RFC 5737)
    ipaddress.ip_network("203.0.113.0/24"),    # TEST-NET-3 (RFC 5737)
    ipaddress.ip_network("240.0.0.0/4"),       # reserved (RFC 1112)
    ipaddress.ip_network("255.255.255.255/32"),  # broadcast
    ipaddress.ip_network("::1/128"),           # IPv6 loopback
    ipaddress.ip_network("fe80::/10"),         # IPv6 link-local
    ipaddress.ip_network("fc00::/7"),          # IPv6 unique-local (ULA, RFC 4193)
    ipaddress.ip_network("::/128"),            # IPv6 unspecified
]


class SSRFBlockedError(ValueError):
    """Raised when a URL resolves to a blocked (private/internal) address."""


def _resolve_hostname(hostname: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    """Resolve *hostname* to an IP address object.

    Raises ``socket.gaierror`` on DNS failure.
    """
    addr_str = socket.gethostbyname(hostname)
    return ipaddress.ip_address(addr_str)


def is_safe_url(url: str) -> bool:
    """Return True iff *url* is safe to fetch (does not target a private address)."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return False
        addr = _resolve_hostname(hostname)
        return not any(addr in net for net in _BLOCKED_NETWORKS)
    except Exception:
        return False


def assert_safe_url(url: str) -> None:
    """Raise :class:`SSRFBlockedError` if *url* resolves to a private/internal address.

    Also rejects URLs with missing or unresolvable hostnames.
    """
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise SSRFBlockedError(f"Invalid or missing hostname in URL: {url!r}")
    try:
        addr = _resolve_hostname(hostname)
    except socket.gaierror as exc:
        raise SSRFBlockedError(f"DNS resolution failed for {hostname!r}: {exc}") from exc
    for net in _BLOCKED_NETWORKS:
        if addr in net:
            raise SSRFBlockedError(
                f"URL {url!r} resolves to {addr}, which is in blocked range {net} — "
                "fetching private/internal addresses is not allowed"
            )
