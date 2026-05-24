"""Per-install auth token for the localhost API.

OpenSwarm's backend runs a FastAPI server on `127.0.0.1:<random-port>`
and streams sensitive agent data (tool inputs, approval requests,
messages) over WebSockets. Without auth, any webpage loaded in any
browser on the same machine can connect to those endpoints — WebSockets
aren't subject to Same-Origin Policy — and impersonate the user.

This module issues a cryptographically random token on first boot,
writes it 0600 to `<DATA_ROOT>/auth.token`, and reuses it on subsequent
restarts (so dev-mode hot-reload doesn't break the renderer's cached
copy). The token is regenerated only when the file is missing or empty.
Only code running as the same OS user can read the file.

Delivery to legitimate consumers:

- Electron main process reads the file and exposes it to the renderer
  via a contextBridge method in preload.js (NOT plain window global).
- Our Python MCP subprocesses receive it via env var
  `OPENSWARM_AUTH_TOKEN` that agent_manager passes when spawning.
- The Claude Code CLI we spawn receives it as `ANTHROPIC_API_KEY` in
  env; the anthropic-proxy route trusts that value.

None of those paths are accessible from a third-party webpage.
"""

from __future__ import annotations

import logging
import os
import secrets

from backend.config.paths import AUTH_TOKEN_FILE, DATA_ROOT

logger = logging.getLogger(__name__)

_TOKEN: str = ""


def _write_atomic(path: str, data: str, mode: int = 0o600) -> None:
    """Write `data` to `path` atomically with the given file mode.

    Uses `os.open(..., O_CREAT|O_WRONLY|O_TRUNC, mode)` + rename so the
    final file is never world-readable and never left half-written if
    the backend crashes mid-write. Windows-safe (rename of a file over
    an existing one works on NTFS when the source was just closed).
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, mode)
    try:
        os.write(fd, data.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)


def init_auth_token() -> str:
    """Initialise the per-install auth token, persisting to disk.

    Behaviour: prefer an existing token on disk; only mint a fresh one
    when the file is absent or empty. This matters for two cases:

      1. Dev mode (`bash run.sh`) — uvicorn's WatchFiles reload restarts
         the worker process and re-runs init_auth_token. If we generated
         a fresh token every reload, Electron's cached token (read once
         at app boot) would mismatch and every authed request 401s
         until the user fully restarts. Preserving the on-disk token
         keeps Electron and the backend in sync across reloads.

      2. Packaged builds — the user can restart the backend (Quit + reopen)
         without the renderer reloading. Same mismatch risk, same fix.

    Security trade-off: we no longer rotate the token on every restart.
    The threat model that rotation was protecting against (a stale token
    sitting in a log/crash dump being usable later) is marginal — anyone
    who can read the artifact can also re-read the on-disk token, and
    real rotation requires the file to be deleted (e.g. by signing out
    or wiping the data root). Net: dev-mode reliability wins.
    """
    global _TOKEN
    # Try existing on-disk token first.
    try:
        if os.path.exists(AUTH_TOKEN_FILE):
            with open(AUTH_TOKEN_FILE, "r", encoding="utf-8") as f:
                existing = f.read().strip()
            if existing and 16 <= len(existing) <= 512:
                _TOKEN = existing
                logger.info(
                    f"auth: reusing existing token from {AUTH_TOKEN_FILE}"
                )
                return _TOKEN
    except Exception as e:
        # Fall through to fresh generation on any read error.
        logger.warning(f"auth: failed to read existing token, generating new: {e}")

    _TOKEN = secrets.token_urlsafe(32)
    try:
        _write_atomic(AUTH_TOKEN_FILE, _TOKEN, mode=0o600)
        logger.info(f"auth: wrote token to {AUTH_TOKEN_FILE} (mode 0600)")
    except Exception as e:
        # Fail open is NOT an option here — if we can't write the file,
        # Electron can't read it, and the user sees a broken app. But
        # don't hard-crash the backend either; log loudly.
        logger.error(f"auth: failed to write token file: {e}")
    return _TOKEN


def get_auth_token() -> str:
    """Return the current token. Empty string if init_auth_token() hasn't run."""
    return _TOKEN


class _TokenScrubFilter(logging.Filter):
    """Logging filter that redacts the install token from any log record.

    The token leaks into logs in a few mundane ways: subprocess env dicts
    that get logged when an MCP server fails to spawn, urllib retry logs
    that include `?token=...` query strings, exception tracebacks that
    print the response body of a failed proxied request. None of those
    are intentional but they all happen, and the file ends up in crash
    dumps / shared bug reports / hosted log aggregators. This filter is
    pure defense in depth — behavior is unchanged when the token is
    absent from a record.
    """

    _PLACEHOLDER = "<REDACTED:openswarm-token>"

    @staticmethod
    def _args_might_contain_token(args) -> bool:
        """Cheap pre-check: does any positional arg or dict-arg value mention
        the token? Avoids the cost of `record.getMessage()` (which eagerly
        does %-formatting) on the >99% of log lines that don't touch it."""
        if not args:
            return False
        items = args if isinstance(args, (tuple, list)) else (args,)
        for a in items:
            if isinstance(a, str) and _TOKEN in a:
                return True
            if isinstance(a, dict):
                for v in a.values():
                    if isinstance(v, str) and _TOKEN in v:
                        return True
        return False

    @classmethod
    def _scrub_args(cls, args):
        """Replace token within args in-place-equivalent, preserving the
        original tuple/dict shape. Uvicorn's AccessFormatter unpacks
        record.args as a 5-tuple (client_addr, method, full_path,
        http_version, status_code); blanking args to None — what the
        previous slow path did — triggered `cannot unpack non-iterable
        NoneType object` for every access-logged line that contained
        `?token=...`. Returns the same object if nothing was rewritten."""
        if args is None:
            return args
        if isinstance(args, dict):
            new_dict = None
            for k, v in args.items():
                if isinstance(v, str) and _TOKEN in v:
                    if new_dict is None:
                        new_dict = dict(args)
                    new_dict[k] = v.replace(_TOKEN, cls._PLACEHOLDER)
            return new_dict if new_dict is not None else args
        if isinstance(args, tuple):
            new_list = None
            for i, v in enumerate(args):
                if isinstance(v, str) and _TOKEN in v:
                    if new_list is None:
                        new_list = list(args)
                    new_list[i] = v.replace(_TOKEN, cls._PLACEHOLDER)
            return tuple(new_list) if new_list is not None else args
        if isinstance(args, str) and _TOKEN in args:
            return args.replace(_TOKEN, cls._PLACEHOLDER)
        return args

    def filter(self, record: logging.LogRecord) -> bool:  # pragma: no cover (defensive)
        if not _TOKEN:
            return True
        # Fast path: the overwhelming majority of log records don't mention
        # the token at all. Two cheap string-in-string scans (raw msg + each
        # arg) are far cheaper than forcing record.getMessage(), which would
        # do eager %-formatting on every record in the process.
        raw_msg = record.msg if isinstance(record.msg, str) else ""
        if _TOKEN not in raw_msg and not self._args_might_contain_token(record.args):
            return True
        # Slow path. Two-step scrub so we cover both shapes:
        #   1. In-place rewrite of record.msg and any string in record.args
        #      (or string-valued dict entry). Preserves args shape so
        #      uvicorn's AccessFormatter — which unpacks record.args as a
        #      5-tuple and would explode on args=None — keeps working.
        #   2. Render via record.getMessage() and check the substituted
        #      output. If a token survived step 1 (because it was buried
        #      inside a nested structure or a custom object's repr, e.g.
        #      `logger.info("env: %s", env_dict)` where the dict's repr
        #      exposes the value), bake the redacted final string into
        #      record.msg and clear args. This last-resort path only
        #      trips for records that the in-place pass couldn't reach,
        #      and uvicorn access logs never hit it (their args are
        #      always primitive strings/ints, fully scrubbed by step 1).
        try:
            if isinstance(record.msg, str) and _TOKEN in record.msg:
                record.msg = record.msg.replace(_TOKEN, self._PLACEHOLDER)
            scrubbed = self._scrub_args(record.args)
            if scrubbed is not record.args:
                record.args = scrubbed
            try:
                rendered = record.getMessage()
                if _TOKEN in rendered:
                    record.msg = rendered.replace(_TOKEN, self._PLACEHOLDER)
                    record.args = None
            except Exception:
                pass
        except Exception:
            # Never let the scrubber suppress a log line — if formatting
            # fails for any reason, fall through and let normal handling
            # proceed (worst case the token leaks for that one record).
            pass
        return True


_scrubber_installed = False


def install_token_scrubber() -> None:
    """Attach the token-scrubbing filter to every log handler in the process.

    Why not just `root.addFilter(...)`: filters attached to a Logger only
    fire on records emitted DIRECTLY on that logger. Records propagated up
    from child loggers (uvicorn.access, uvicorn.error, websockets, etc.)
    flow into root's HANDLERS without ever consulting root's logger-level
    filters. So a logger-level install silently misses the access log —
    which is exactly the line that contains `?token=...` query params.

    This implementation:
      1. Walks every currently-registered logger (root + everything in
         `Logger.manager.loggerDict`) and attaches the scrubber to each
         of their handlers.
      2. Monkey-patches `Logger.addHandler` so any handler installed
         AFTER this call (uvicorn configures its loggers during startup,
         after main.py finishes importing) also gets the scrubber.
      3. Keeps the root-logger filter as belt-and-suspenders for the
         records that ARE emitted directly on root.

    Idempotent — repeated calls are a no-op.
    """
    global _scrubber_installed
    if _scrubber_installed:
        return

    scrubber = _TokenScrubFilter()

    def _attach(handler: logging.Handler) -> None:
        if not any(isinstance(f, _TokenScrubFilter) for f in handler.filters):
            handler.addFilter(scrubber)

    # 1. Existing handlers across every known logger.
    loggers: list[logging.Logger] = [logging.getLogger()]
    for logger in logging.root.manager.loggerDict.values():
        if isinstance(logger, logging.Logger):
            loggers.append(logger)
    for logger in loggers:
        for h in list(logger.handlers):
            _attach(h)

    # 2. Future handlers — patch Logger.addHandler so anything attached
    #    after this point (uvicorn finishing its log config, plugins
    #    that reconfigure logging on their own) also gets scrubbed.
    _original_addHandler = logging.Logger.addHandler

    def _patched_addHandler(self: logging.Logger, hdlr: logging.Handler) -> None:
        _attach(hdlr)
        return _original_addHandler(self, hdlr)

    logging.Logger.addHandler = _patched_addHandler  # type: ignore[assignment]

    # 3. Belt-and-suspenders on root logger itself.
    root = logging.getLogger()
    if not any(isinstance(f, _TokenScrubFilter) for f in root.filters):
        root.addFilter(scrubber)

    _scrubber_installed = True


# Paths that never require auth. These are the public surface.
_AUTH_EXEMPT_EXACT = {
    # External OAuth providers redirect the user's browser here. The
    # browser has no way to inject our bearer token (it's a 302 from
    # Google/Anthropic/etc). The `state` query param is already a
    # one-time nonce validated against `_pending_oauth`.
    "/api/subscriptions/callback",
    # Same pattern for the per-tool OAuth flow (Notion / Google Workspace /
    # Airtable / HubSpot / Discord). The browser hits this with ?code=...&state=...
    # after the user approves on the provider's site; the `state` param is
    # the tool_id which we cross-check against _pending_oauth in tools_lib.py.
    # Without this exemption the redirect lands a 401 page in the user's
    # browser — see tools_lib.py:1156 where redirect_uri is constructed.
    "/api/tools/oauth/callback",
    # Browser-redirect target for the proxied OAuth claim handoff. Browser
    # has no way to inject our bearer token; the install_id check inside
    # the handler is what binds the request to this user.
    "/api/tools/oauth/cloud-claim",
    # Bearer-handoff endpoints called by api.openswarm.com's success page
    # AFTER Stripe checkout / Google sign-in / magic-link sign-in. The
    # request POSTs the just-minted cloud bearer; the handler then re-
    # validates it against the cloud (/api/me or /api/auth/signin-activate).
    # The browser has no way to attach our per-install token here — the
    # cloud-validated bearer in the body is the actual auth mechanism.
    "/api/subscription/activate",
    "/api/auth/signin-activate",
    # Browser-only dev/frontend mode has no Electron preload bridge to read
    # AUTH_TOKEN_FILE. This localhost-origin-gated route returns the same
    # per-install bearer so the React app can authenticate normal API calls.
    "/api/auth/browser-token",
    # Browser-only Google sign-in fallback. Plain browsers do not have the
    # Electron preload/deep-link bridge, so they complete OAuth through a
    # localhost callback instead of api.openswarm.com's openswarm:// handoff.
    "/api/auth/google/start",
    "/api/auth/google/callback",
    # Browser-only dev mode (frontend on localhost without Electron preload)
    # needs a valid install_id to start sign-in. This endpoint returns only
    # that identifier (no secrets), so it's safe to expose without bearer auth.
    "/api/settings/install-id",
    "/api/version",
    # Local Google OAuth token-endpoint proxy: hit by the
    # google-workspace-mcp subprocess we spawn. It doesn't (and can't
    # easily) carry the install bearer in google-auth's refresh post.
    # Localhost binding is the gate, and the route does nothing the
    # public api.openswarm.com/api/oauth/google/refresh doesn't already
    # do for any internet caller, so no new attack surface.
    "/api/tools/google-oauth-token",
}

# Path prefixes that never require auth. Trailing slash optional.
_AUTH_EXEMPT_PREFIX = (
    # Electron's boot handshake polls /api/health/check before it has a
    # token (the HTTP port is up before main.js calls loadAuthToken()).
    # Use a prefix so /api/health/check — and any future sub-route — is
    # covered without re-introducing the bootstrap deadlock that an
    # exact "/api/health" match caused.
    "/api/health",
    # OpenAI API pass-through. 9Router calls this with the user's
    # OpenAI Bearer token (sk-…), NOT our local auth token, so our
    # middleware would reject. Localhost-only network boundary is the
    # security gate — the route only forwards to api.openai.com and
    # never touches user data on this machine. See
    # backend/apps/agents/openai_passthrough.py for why this exists.
    "/api/openai-passthrough",
    # FastAPI's default health/docs/schema surface (packaged app never
    # ships /docs, but be defensive).
    "/docs",
    "/openapi",
    "/redoc",
    "/favicon",
)


def is_path_exempt(path: str) -> bool:
    """True if this request path bypasses token auth."""
    if path in _AUTH_EXEMPT_EXACT:
        return True
    for p in _AUTH_EXEMPT_PREFIX:
        if path.startswith(p):
            return True
    return False


def extract_bearer(header_value: str | None) -> str:
    """Pull the token out of `Authorization: Bearer <token>`."""
    if not header_value:
        return ""
    if header_value.startswith("Bearer "):
        return header_value[len("Bearer "):].strip()
    if header_value.startswith("bearer "):
        return header_value[len("bearer "):].strip()
    return ""


def request_matches_token(request_headers: dict, query_params: dict | None = None) -> bool:
    """Validate that an incoming HTTP / WS request carries our token.

    Accepts any of:
      - `Authorization: Bearer <token>`
      - `x-openswarm-token: <token>` (custom header for callers that
        can't easily set Authorization — e.g. future CLI clients)
      - `?token=<token>` query param (WS only; browsers can't easily
        set custom WS headers, so the token rides in the URL)

    The token comparison is constant-time via `secrets.compare_digest`.
    """
    if not _TOKEN:
        # Backend started without auth init — fail closed. This should
        # only happen in test fixtures that intentionally bypass main.
        return False

    candidates: list[str] = []

    auth = request_headers.get("authorization") or request_headers.get("Authorization")
    bearer = extract_bearer(auth)
    if bearer:
        candidates.append(bearer)

    openswarm_header = (
        request_headers.get("x-openswarm-token")
        or request_headers.get("X-OpenSwarm-Token")
    )
    if openswarm_header:
        candidates.append(openswarm_header.strip())

    if query_params:
        qp_token = query_params.get("token")
        if qp_token:
            candidates.append(qp_token)

    for candidate in candidates:
        if secrets.compare_digest(candidate, _TOKEN):
            return True
    return False


# Origin allowlist for WS handshakes. Electron's renderer loads from
# `file://` when packaged; `http://localhost:3000` (Vite dev server) and
# `http://127.0.0.1:3000` in dev. A bare `null` Origin is sent by some
# Electron contexts.
_ORIGIN_ALLOWLIST_DEV = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    # Electron may load prod build from file:// or an app:// scheme.
    "file://",
    "null",
}


def is_origin_allowed(origin: str | None) -> bool:
    """True if the WS connection's Origin header is from our app."""
    if origin is None:
        # No Origin header = curl / native WS client / MCP subprocess.
        # Token check is still required, so allow.
        return True
    if origin in _ORIGIN_ALLOWLIST_DEV:
        return True
    # file:// origins in Electron prod sometimes include paths like
    # file:///Applications/OpenSwarm.app/... — match by prefix.
    if origin.startswith("file://"):
        return True
    # localhost + any port (dev servers, tools the developer is running).
    if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
        return True
    return False
