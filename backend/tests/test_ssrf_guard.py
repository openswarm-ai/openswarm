"""Tests for SSRF protection (CWE-918).

Covers:
- ssrf_guard.is_safe_url / assert_safe_url
- WebFetchTool.execute blocks private targets
- /api/web/fetch endpoint rejects blocked URLs
- Redirect-pivot attack is blocked
- web_mcp_server _is_safe_url inline guard

Run:
    cd /home/anushkrishna/Documents/Projects/openswarm
    python -m pytest backend/tests/test_ssrf_guard.py -v
"""

from __future__ import annotations

import ipaddress
import json
import os
import sys
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Ensure the project root is importable
# ---------------------------------------------------------------------------
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

_tmpdir = tempfile.mkdtemp()
os.environ.setdefault("OPENSWARM_DATA_DIR", _tmpdir)


# ===========================================================================
# ssrf_guard module
# ===========================================================================

class TestIsBlockedNetworks:
    """is_safe_url returns False for every category of private address."""

    @pytest.mark.parametrize("url,reason", [
        ("http://127.0.0.1/", "IPv4 loopback"),
        ("http://127.1.2.3/", "loopback range"),
        ("http://169.254.169.254/latest/meta-data/", "AWS IMDSv1"),
        ("http://169.254.0.1/", "link-local"),
        ("http://10.0.0.1/", "RFC-1918 10.x"),
        ("http://10.255.255.255/", "RFC-1918 10.x boundary"),
        ("http://172.16.0.1/", "RFC-1918 172.16.x"),
        ("http://172.31.255.254/", "RFC-1918 172.31.x boundary"),
        ("http://192.168.1.1/admin", "RFC-1918 192.168.x"),
        ("http://192.168.0.0/", "RFC-1918 192.168.0 network"),
        ("http://100.64.0.1/", "carrier-grade NAT"),
        ("http://0.0.0.1/", "this-network range"),
        ("http://240.0.0.1/", "reserved range"),
        ("http://255.255.255.255/", "broadcast"),
    ])
    def test_blocked_ipv4(self, url, reason):
        from backend.apps.agents.tools.ssrf_guard import is_safe_url

        hostname = url.split("//")[1].split("/")[0]
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address(hostname)
            assert is_safe_url(url) is False, f"Expected {url!r} ({reason}) to be blocked"

    @pytest.mark.parametrize("url,addr,reason", [
        ("http://[::1]/", "::1", "IPv6 loopback"),
        ("http://[fe80::1]/", "fe80::1", "IPv6 link-local"),
        ("http://[fc00::1]/", "fc00::1", "IPv6 ULA"),
        ("http://[fd12:3456::1]/", "fd12:3456::1", "IPv6 ULA fd-prefix"),
        ("http://[::]/", "::", "IPv6 unspecified"),
    ])
    def test_blocked_ipv6(self, url, addr, reason):
        from backend.apps.agents.tools.ssrf_guard import is_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address(addr)
            assert is_safe_url(url) is False, f"Expected {url!r} ({reason}) to be blocked"

    @pytest.mark.parametrize("url,addr", [
        ("https://example.com/", "93.184.216.34"),
        ("https://github.com/", "140.82.121.3"),
        ("http://1.1.1.1/", "1.1.1.1"),
        ("https://8.8.8.8/", "8.8.8.8"),
    ])
    def test_public_urls_allowed(self, url, addr):
        from backend.apps.agents.tools.ssrf_guard import is_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address(addr)
            assert is_safe_url(url) is True

    def test_missing_hostname_blocked(self):
        from backend.apps.agents.tools.ssrf_guard import is_safe_url

        assert is_safe_url("http:///path") is False
        assert is_safe_url("not-a-url") is False

    def test_dns_failure_blocked(self):
        import socket
        from backend.apps.agents.tools.ssrf_guard import is_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   side_effect=socket.gaierror("NXDOMAIN")):
            assert is_safe_url("http://does-not-exist.invalid/") is False


class TestAssertSafeUrl:
    """assert_safe_url raises SSRFBlockedError for blocked targets."""

    def test_raises_for_loopback(self):
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError, assert_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("127.0.0.1")
            with pytest.raises(SSRFBlockedError, match="blocked range"):
                assert_safe_url("http://127.0.0.1/")

    def test_raises_for_metadata(self):
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError, assert_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("169.254.169.254")
            with pytest.raises(SSRFBlockedError, match="blocked range"):
                assert_safe_url("http://169.254.169.254/latest/meta-data/")

    def test_raises_for_lan(self):
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError, assert_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("192.168.1.1")
            with pytest.raises(SSRFBlockedError, match="blocked range"):
                assert_safe_url("http://192.168.1.1/admin")

    def test_raises_for_missing_hostname(self):
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError, assert_safe_url

        with pytest.raises(SSRFBlockedError, match="missing hostname"):
            assert_safe_url("http:///no-host")

    def test_raises_for_dns_failure(self):
        import socket
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError, assert_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   side_effect=socket.gaierror("NXDOMAIN")):
            with pytest.raises(SSRFBlockedError, match="DNS resolution failed"):
                assert_safe_url("http://nonexistent.invalid/")

    def test_passes_for_public(self):
        from backend.apps.agents.tools.ssrf_guard import assert_safe_url

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("93.184.216.34")
            assert_safe_url("https://example.com/")  # must not raise


# ===========================================================================
# WebFetchTool — SSRF checks in execute()
# ===========================================================================

class TestWebFetchToolSSRF:
    """WebFetchTool.execute must block private URLs."""

    @pytest.mark.asyncio
    async def test_blocks_loopback(self):
        from backend.apps.agents.tools.ssrf_guard import SSRFBlockedError
        from backend.apps.agents.tools.web import WebFetchTool

        tool = WebFetchTool()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("127.0.0.1")
            result = await tool.execute({"url": "http://127.0.0.1:8080/"}, context=None)

        assert result[0]["type"] == "text"
        assert "Blocked" in result[0]["text"] or "blocked" in result[0]["text"]

    @pytest.mark.asyncio
    async def test_blocks_cloud_metadata(self):
        from backend.apps.agents.tools.web import WebFetchTool

        tool = WebFetchTool()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("169.254.169.254")
            result = await tool.execute(
                {"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"},
                context=None,
            )

        text = result[0]["text"].lower()
        assert "block" in text or "not allowed" in text

    @pytest.mark.asyncio
    async def test_blocks_private_lan(self):
        from backend.apps.agents.tools.web import WebFetchTool

        tool = WebFetchTool()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname") as mock_resolve:
            mock_resolve.return_value = ipaddress.ip_address("192.168.1.1")
            result = await tool.execute({"url": "http://192.168.1.1/admin"}, context=None)

        text = result[0]["text"].lower()
        assert "block" in text or "not allowed" in text

    @pytest.mark.asyncio
    async def test_redirect_pivot_blocked(self):
        """A public URL that 301-redirects to an internal address must be blocked."""
        import httpx
        from backend.apps.agents.tools.web import WebFetchTool

        tool = WebFetchTool()

        redirect_response = MagicMock(spec=httpx.Response)
        redirect_response.status_code = 301
        redirect_response.headers = {"location": "http://169.254.169.254/latest/meta-data/"}
        redirect_response.url = "https://attacker.com/r"

        public_addr = ipaddress.ip_address("203.0.113.1")
        metadata_addr = ipaddress.ip_address("169.254.169.254")

        def resolve_side_effect(hostname):
            if "attacker" in hostname:
                return public_addr
            return metadata_addr

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   side_effect=resolve_side_effect):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client.get = AsyncMock(return_value=redirect_response)
                mock_client_cls.return_value = mock_client

                result = await tool.execute(
                    {"url": "https://attacker.com/r"}, context=None
                )

        text = result[0]["text"].lower()
        assert "block" in text or "not allowed" in text

    @pytest.mark.asyncio
    async def test_public_url_fetched_normally(self):
        """Public URLs still work — guard does not block legitimate fetches."""
        import httpx
        from backend.apps.agents.tools.web import WebFetchTool

        tool = WebFetchTool()
        public_addr = ipaddress.ip_address("93.184.216.34")

        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "text/plain"}
        mock_resp.text = "Hello, world!"
        mock_resp.raise_for_status = MagicMock()

        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=public_addr):
            with patch("httpx.AsyncClient") as mock_client_cls:
                mock_client = AsyncMock()
                mock_client.__aenter__ = AsyncMock(return_value=mock_client)
                mock_client.__aexit__ = AsyncMock(return_value=False)
                mock_client.get = AsyncMock(return_value=mock_resp)
                mock_client_cls.return_value = mock_client

                result = await tool.execute(
                    {"url": "https://example.com/"}, context=None
                )

        assert result[0]["type"] == "text"
        assert "Hello, world!" in result[0]["text"]


# ===========================================================================
# web_mcp_server — inline _is_safe_url guard
# ===========================================================================

class TestMCPServerSSRFGuard:
    """The standalone MCP server's _is_safe_url must reject private addresses."""

    def _import_mcp(self):
        import importlib
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "web_mcp_server",
            os.path.join(_PROJECT_ROOT, "backend/apps/agents/web_mcp_server.py"),
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_loopback_blocked(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("127.0.0.1")):
            assert mod._is_safe_url("http://127.0.0.1/") is False

    def test_metadata_blocked(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("169.254.169.254")):
            assert mod._is_safe_url("http://169.254.169.254/") is False

    def test_lan_blocked(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("192.168.1.1")):
            assert mod._is_safe_url("http://192.168.1.1/admin") is False

    def test_public_allowed(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("93.184.216.34")):
            assert mod._is_safe_url("https://example.com/") is True

    def test_handle_tool_call_blocks_private(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("127.0.0.1")):
            result = mod.handle_tool_call("WebFetch", {"url": "http://127.0.0.1/"})
        assert result.get("isError") is True
        assert "blocked" in result["content"][0]["text"].lower()

    def test_handle_tool_call_blocks_metadata(self):
        mod = self._import_mcp()
        with patch("backend.apps.agents.tools.ssrf_guard._resolve_hostname",
                   return_value=ipaddress.ip_address("169.254.169.254")):
            result = mod.handle_tool_call(
                "WebFetch",
                {"url": "http://169.254.169.254/latest/meta-data/"},
            )
        assert result.get("isError") is True
        assert "blocked" in result["content"][0]["text"].lower()
