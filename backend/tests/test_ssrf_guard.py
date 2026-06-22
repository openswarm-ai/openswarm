"""Regression tests for the SSRF guard.

Covers the plain ranges and the v4-in-v6 smuggling bypass: a private/metadata
v4 target hidden inside a v6 address (v4-mapped ::ffff:, 6to4 2002::) used to
slip past the v6-only blocklist. Surfaced while running the OPENSAGE
comprehension-gap probe against this module.
"""

import pytest

from apps.agents.tools.ssrf_guard import SSRFBlocked, _is_forbidden_ip, assert_safe_url


@pytest.mark.parametrize(
    "ip_str, forbidden",
    [
        # plain ranges still behave
        ("10.0.0.1", True),
        ("169.254.169.254", True),            # cloud metadata
        ("8.8.8.8", False),                   # public
        ("127.0.0.1", False),                 # loopback intentionally allowed
        ("::1", False),                       # v6 loopback allowed
        ("2606:4700::1", False),              # public v6
        ("fe80::1", True),                    # v6 link-local
        ("not-an-ip", True),                  # unparseable -> block
        # the bypass: a v4 target smuggled inside a v6 address
        ("::ffff:10.0.0.1", True),            # v4-mapped private
        ("::ffff:169.254.169.254", True),     # v4-mapped cloud metadata
        ("2002:0a00:0001::1", True),          # 6to4 of 10.0.0.1
        ("::ffff:127.0.0.1", False),          # v4-mapped loopback stays allowed
        ("::ffff:8.8.8.8", False),            # v4-mapped public stays allowed
    ],
)
def test_is_forbidden_ip(ip_str, forbidden):
    assert _is_forbidden_ip(ip_str) is forbidden


@pytest.mark.asyncio
async def test_assert_safe_url_blocks_v4_mapped_metadata():
    # IP-literal host short-circuits before DNS, so this needs no network.
    with pytest.raises(SSRFBlocked):
        await assert_safe_url("http://[::ffff:169.254.169.254]/latest/meta-data/")


@pytest.mark.asyncio
async def test_assert_safe_url_allows_v4_mapped_loopback():
    # App Builder previews on loopback must keep working, even v4-mapped.
    url = "http://[::ffff:127.0.0.1]:8731/"
    assert await assert_safe_url(url) == url
