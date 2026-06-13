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
import os

import google_workspace_mcp.auth.gauth as gauth
from google.oauth2.credentials import Credentials


@functools.lru_cache(maxsize=1)
def _patched_get_credentials():
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


gauth.get_credentials = _patched_get_credentials # vulture-ignore: get_credentials


from google_workspace_mcp import __main__ as _gw_main  # noqa: E402,F401
from google_workspace_mcp.app import mcp  # noqa: E402


if __name__ == "__main__":
    # Upstream google_workspace_mcp.__main__.main() wraps a synchronous
    # mcp.run() in asyncio.run() which throws "a coroutine was expected,
    # got None" against current FastMCP. Skip it and invoke FastMCP's
    # stdio loop directly. The `_gw_main` import above is what actually
    # registers every tool/prompt/resource module against the shared
    # `mcp` instance via its top-level imports.
    mcp.run("stdio")
