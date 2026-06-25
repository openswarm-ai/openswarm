"""Per-install bearer token gating the localhost API and WS streams."""

from __future__ import annotations

import logging
import os
import secrets

from backend.config.paths import AUTH_TOKEN_FILE, DATA_ROOT

logger = logging.getLogger(__name__)

TOKEN: str = ""


def p_write_atomic(path: str, data: str, mode: int = 0o600) -> None:
    """Atomic write to `path` at the given file mode; never world-readable or half-written."""
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
    """Load the per-install token from disk, or mint one if missing; reused across restarts so Electron's cached copy stays valid."""
    global TOKEN
    try:
        if os.path.exists(AUTH_TOKEN_FILE):
            with open(AUTH_TOKEN_FILE, "r", encoding="utf-8") as f:
                existing = f.read().strip()
            if existing and 16 <= len(existing) <= 512:
                TOKEN = existing
                logger.info(
                    f"auth: reusing existing token from {AUTH_TOKEN_FILE}"
                )
                return TOKEN
    except Exception as e:
        logger.warning(f"auth: failed to read existing token, generating new: {e}")

    TOKEN = secrets.token_urlsafe(32)
    try:
        p_write_atomic(AUTH_TOKEN_FILE, TOKEN, mode=0o600)
        logger.info(f"auth: wrote token to {AUTH_TOKEN_FILE} (mode 0600)")
    except Exception as e:
        # If we can't write the file, Electron can't read it; log loudly but don't crash.
        logger.error(f"auth: failed to write token file: {e}")
    return TOKEN


def get_auth_token() -> str:
    """Return the current token. Empty string if init_auth_token() hasn't run."""
    return TOKEN


class p_TokenScrubFilter(logging.Filter):
    """Logging filter that redacts the install token from log records (defense in depth)."""

    P_PLACEHOLDER = "<REDACTED:openswarm-token>"

    @staticmethod
    def p_args_might_contain_token(args) -> bool:
        """Cheap pre-check; avoids eager %-formatting on the >99% of records that don't mention the token."""
        if not args:
            return False
        items = args if isinstance(args, (tuple, list)) else (args,)
        for a in items:
            if isinstance(a, str) and TOKEN in a:
                return True
            if isinstance(a, dict):
                for v in a.values():
                    if isinstance(v, str) and TOKEN in v:
                        return True
        return False

    @classmethod
    def p_scrub_args(cls, args):
        """Scrub token from args while preserving tuple/dict shape; uvicorn's AccessFormatter unpacks args as a 5-tuple and explodes on None."""
        if args is None:
            return args
        if isinstance(args, dict):
            new_dict = None
            for k, v in args.items():
                if isinstance(v, str) and TOKEN in v:
                    if new_dict is None:
                        new_dict = dict(args)
                    new_dict[k] = v.replace(TOKEN, cls.P_PLACEHOLDER)
            return new_dict if new_dict is not None else args
        if isinstance(args, tuple):
            new_list = None
            for i, v in enumerate(args):
                if isinstance(v, str) and TOKEN in v:
                    if new_list is None:
                        new_list = list(args)
                    new_list[i] = v.replace(TOKEN, cls.P_PLACEHOLDER)
            return tuple(new_list) if new_list is not None else args
        if isinstance(args, str) and TOKEN in args:
            return args.replace(TOKEN, cls.P_PLACEHOLDER)
        return args

    def filter(self, record: logging.LogRecord) -> bool:  # pragma: no cover (defensive)
        if not TOKEN:
            return True
        # Fast path: skip eager %-formatting on records that don't mention the token.
        raw_msg = record.msg if isinstance(record.msg, str) else ""
        if TOKEN not in raw_msg and not self.p_args_might_contain_token(record.args):
            return True
        # Slow path: in-place args rewrite (preserves shape for AccessFormatter), then re-render to catch tokens buried in custom reprs.
        try:
            if isinstance(record.msg, str) and TOKEN in record.msg:
                record.msg = record.msg.replace(TOKEN, self.P_PLACEHOLDER)
            scrubbed = self.p_scrub_args(record.args)
            if scrubbed is not record.args:
                record.args = scrubbed
            try:
                rendered = record.getMessage()
                if TOKEN in rendered:
                    record.msg = rendered.replace(TOKEN, self.P_PLACEHOLDER)
                    record.args = None
            except Exception:
                pass
        except Exception:
            # Never let the scrubber suppress a log line; worst case the token leaks for that one record.
            pass
        return True


p_scrubber_installed = False


def install_token_scrubber() -> None:
    """Attach the scrubbing filter to every existing AND future log handler; logger-level filters miss propagated child records."""
    global p_scrubber_installed
    if p_scrubber_installed:
        return

    scrubber = p_TokenScrubFilter()

    def p_attach(handler: logging.Handler) -> None:
        if not any(isinstance(f, p_TokenScrubFilter) for f in handler.filters):
            handler.addFilter(scrubber)

    loggers: list[logging.Logger] = [logging.getLogger()]
    for logger in logging.root.manager.loggerDict.values():
        if isinstance(logger, logging.Logger):
            loggers.append(logger)
    for logger in loggers:
        for h in list(logger.handlers):
            p_attach(h)

    # Patch addHandler so handlers attached later (uvicorn finishes log config after main.py imports) get the scrubber too.
    p_original_addHandler = logging.Logger.addHandler

    def p_patched_addHandler(self: logging.Logger, hdlr: logging.Handler) -> None:
        p_attach(hdlr)
        return p_original_addHandler(self, hdlr)

    logging.Logger.addHandler = p_patched_addHandler  # type: ignore[assignment]

    root = logging.getLogger()
    if not any(isinstance(f, p_TokenScrubFilter) for f in root.filters):
        root.addFilter(scrubber)

    p_scrubber_installed = True


# Auth-exempt paths: external redirects with their own nonce/state validation, plus the bootstrap health probe.
P_AUTH_EXEMPT_EXACT = {
    "/api/subscriptions/callback",
    "/api/tools/oauth/callback",
    "/api/tools/oauth/cloud-claim",
    "/api/subscription/activate",
    "/api/auth/signin-activate",
    "/api/version",
    # Local Google OAuth token-endpoint proxy: hit by the google-workspace-mcp subprocess we spawn. It doesn't (and can't easily) carry the install bearer in google-auth's refresh post. Localhost binding is the gate, and the route does nothing the public api.openswarm.com/api/oauth/google/refresh doesn't already do for any internet caller, so no new attack surface.
    "/api/tools/google-oauth-token",
    # Dev-only token handoff for the split-port frontend (no Electron preload to read the token from). The route itself 404s in packaged builds.
    "/api/dev/token",
}

P_AUTH_EXEMPT_PREFIX = (
    # Electron polls /api/health/check before loading the token.
    "/api/health",
    # 9Router proxies OpenAI requests with the user's sk-... bearer, not our local token; localhost-only is the gate.
    "/api/openai-passthrough",
    "/docs",
    "/openapi",
    "/redoc",
    "/favicon",
)


def is_path_exempt(path: str) -> bool:
    """True if this request path bypasses token auth."""
    if path in P_AUTH_EXEMPT_EXACT:
        return True
    for p in P_AUTH_EXEMPT_PREFIX:
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
    """Validate that an HTTP/WS request carries our token (Bearer, x-openswarm-token, or ?token=); constant-time compare."""
    if not TOKEN:
        # Backend not initialized: fail closed. Only test fixtures that bypass main hit this.
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
        if secrets.compare_digest(candidate, TOKEN):
            return True
    return False


# WS Origin allowlist: Electron packaged is file://, dev is localhost:3000, some Electron contexts send bare "null".
P_ORIGIN_ALLOWLIST_DEV = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "file://",
    "null",
}


def is_origin_allowed(origin: str | None) -> bool:
    """True if the WS connection's Origin header is from our app."""
    if origin is None:
        # Native WS client / curl / MCP subprocess: token check still required, so allow.
        return True
    if origin in P_ORIGIN_ALLOWLIST_DEV:
        return True
    # Packaged Electron file:// includes paths like file:///Applications/OpenSwarm.app/...; match by prefix.
    if origin.startswith("file://"):
        return True
    if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
        return True
    return False
