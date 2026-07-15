"""Run google-workspace-mcp's stdio worker with token refresh redirected
through our local proxy instead of directly to oauth2.googleapis.com.

google_workspace_mcp.auth.gauth.get_credentials() hardcodes
token_uri="https://oauth2.googleapis.com/token" and refreshes with
whatever GOOGLE_WORKSPACE_CLIENT_ID/SECRET are in env on every API call.
OAuth runs through a rotation pool in openswarm-cloud, so the
refresh_token is bound to whichever pool slot minted it, not the single
client baked into the DMG. Refresh directly against Google with the
wrong client returns unauthorized_client.

This wrapper monkey-patches gauth.get_credentials before the worker
imports its tool modules, pointing token_uri at GOOGLE_WORKSPACE_TOKEN_URI
(our local proxy at /api/tools/google-oauth-token, which forwards refresh
requests to the cloud's pool-aware /api/oauth/google/refresh).
CLIENT_ID/SECRET become unused placeholders.
"""

import functools
import importlib.util
import os
import sys

import google_workspace_mcp.auth.gauth as gauth
from google.oauth2.credentials import Credentials

# Load the cap helper as a loose sibling file (not `from backend...`): the shim runs in uv's ephemeral env where the project isn't a package, and a path-load can't drag in backend's transitive deps. Kept next to run.py so the bundle always ships them together.
def p_load_cap():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cap_tool_result.py")
    spec = importlib.util.spec_from_file_location("gws_cap_tool_result", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.cap_tool_result


@functools.lru_cache(maxsize=1)
def p_patched_get_credentials():
    refresh_token = os.environ.get("GOOGLE_WORKSPACE_REFRESH_TOKEN")
    if not refresh_token:
        raise ValueError("GOOGLE_WORKSPACE_REFRESH_TOKEN env var is required")
    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri=os.environ.get(
            "GOOGLE_WORKSPACE_TOKEN_URI",
            "https://oauth2.googleapis.com/token",
        ),
        client_id=os.environ.get("GOOGLE_WORKSPACE_CLIENT_ID", "openswarm-proxy"),
        client_secret=os.environ.get("GOOGLE_WORKSPACE_CLIENT_SECRET", "openswarm-proxy"),
    )


gauth.get_credentials = p_patched_get_credentials


from google_workspace_mcp import __main__ as p_gw_main  # noqa: E402,F401
from google_workspace_mcp.app import mcp  # noqa: E402


# Patch the TOOL MANAGER, not mcp.call_tool: FastMCP.__init__ registers self.call_tool as a bound method with the low-level server, so rebinding the attribute never reaches stdio dispatch; the bound handler resolves self._tool_manager.call_tool dynamically on every request, so this one does. Fail-open: if the helper can't load or upstream reshapes, run uncapped rather than break the whole Google Workspace tool.
try:
    p_cap = p_load_cap()
    p_tool_manager = mcp._tool_manager  # noqa: SLF001
    p_orig_tm_call_tool = p_tool_manager.call_tool

    async def p_capped_tm_call_tool(name, arguments, **kwargs):
        return p_cap(await p_orig_tm_call_tool(name, arguments, **kwargs))

    p_tool_manager.call_tool = p_capped_tm_call_tool
except Exception as p_e:
    print(f"[gws-shim] result cap disabled ({p_e}); running uncapped", file=sys.stderr)


if __name__ == "__main__":
    # Upstream google_workspace_mcp.__main__.main() wraps a synchronous mcp.run() in asyncio.run() which throws "a coroutine was expected, got None" against current FastMCP. Skip it and invoke FastMCP's stdio loop directly. The `_gw_main` import above is what actually registers every tool/prompt/resource module against the shared `mcp` instance via its top-level imports.
    mcp.run("stdio")
