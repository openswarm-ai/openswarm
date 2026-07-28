"""Borrow the sign-in the user already has in their everyday browser, so a browser agent that hits
a login wall can carry on as them instead of stopping to ask them to log in all over again.

The point is that no password is ever typed, stored, or seen. We copy the SESSION the user's real
Chrome/Arc/Brave/Edge already holds into the app's own browser partition. It is the same mechanism
onboarding uses to read the user's provider chat history, pointed at whatever site the agent is
stuck on instead of at a fixed provider list.

Four things keep it narrow:
  - Off unless the user turned it on (`browser_import_signins`, default False). Reading their real
    browser is a decision they make once, explicitly, not one we make for them.
  - The domain is never model-chosen. It comes from the URL of the page the agent is already stuck
    on, so no amount of prompt injection can name a site to harvest.
  - Records only ever travel INTO our own partition. Nothing is read back out.
  - Values are never logged. Counts and domains only.

Coverage is honestly partial: Chromium-family browsers on macOS/Windows, and not Chrome's newer
app-bound (v20) stores. Everything else returns `no_session` and the run falls back to asking the
user to sign in, which is exactly what it did before this existed.

This is the ONE module in browser/ that knows where the reader lives, so the reader can move house
later without anything else noticing.
"""

import asyncio
import logging
from typing import Any, Dict, List, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.browser import browser_login_handoff
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.onboarding.usage import browser_cookies
from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

ImportOutcome = Literal["imported", "disabled", "no_session", "bridge_failed"]

# Google authenticates on the parent SSO domain, so a Gmail/YouTube/Docs session does not live on
# the property's own host. The reader already has a named scope for exactly this, and we reuse it
# rather than sweeping every google entry the user owns.
P_GOOGLE_SUFFIXES = ("google.com", "youtube.com")

# Chromium counts from 1601-01-01 in microseconds, because of course it does. Electron wants unix
# seconds, and an entry with no expiry is session-scoped, so it would evaporate on the next quit.
P_CHROMIUM_EPOCH_OFFSET_S = 11644473600

# Anti-bot clearance tokens are bound to the exact user agent and IP that earned them. Our webview
# keeps an "openswarm/" product token in its UA, so a clearance minted by the user's real Chrome can
# never match ours, and replaying a mismatched one reads as token theft: the edge hands back a fresh
# challenge instead of letting us through, which is WORSE than arriving with no clearance at all.
# Everything else in the jar is the actual session, so we carry that and let the edge re-challenge
# us honestly.
P_FINGERPRINT_BOUND: set = set()


class SessionImportResult(BaseModel):
    """What happened, in a shape the caller can branch on without parsing prose."""

    model_config = ConfigDict(validate_assignment=True)

    outcome: ImportOutcome = "no_session"
    domain: str = ""
    entries_applied: int = 0
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.outcome == "imported"


@typechecked
def is_enabled(settings: AppSettings) -> bool:
    return bool(settings.browser_import_signins)


@typechecked
def is_google_property(domain: str) -> bool:
    d = (domain or "").lower().lstrip(".")
    return any(d == s or d.endswith(f".{s}") for s in P_GOOGLE_SUFFIXES)


@typechecked
def read_site_records(domain: str) -> List[Dict[str, Any]]:
    """The user's own session records for `domain`. Blocking: touches SQLite and may raise one OS
    keychain consent prompt, so callers must keep it off the event loop."""
    try:
        if is_google_property(domain):
            raw = browser_cookies.read_google_session_records()
        else:
            raw = browser_cookies.read_provider_cookie_records(domain)
    except Exception as exc:
        # A browser we cannot read is a fallback, never a crash: the run just asks the user instead.
        logger.info(f"[session-import] read failed for {domain}: {type(exc).__name__}")
        return []
    return [{**r, "expires": p_unix_expiry(r.get("expires_utc"))} for r in raw
            if str(r.get("name") or "").lower() not in P_FINGERPRINT_BOUND]


@typechecked
def p_unix_expiry(expires_utc: Any) -> float:
    """Chromium's stamp as unix seconds, 0.0 for a session-scoped entry (which Electron then leaves
    session-scoped too, so it dies on quit exactly like it would in the source browser)."""
    try:
        raw = int(expires_utc or 0)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, raw / 1_000_000 - P_CHROMIUM_EPOCH_OFFSET_S) if raw > 0 else 0.0


@typechecked
def site_domain(url_or_host: str) -> str:
    """Normalise a URL or bare host to the registrable domain the store is keyed by. Delegates so
    there is exactly one definition of 'which site is this' across the browser modules."""
    return browser_login_handoff.registrable_domain(url_or_host)


@typechecked
def has_importable_session(domain: str) -> bool:
    """Whether some browser store holds a session for this domain, WITHOUT decrypting anything and
    without touching the keychain. Cheap enough to ask before deciding to interrupt the user."""
    d = site_domain(domain)
    if not d:
        return False
    try:
        return browser_cookies.has_store(".google.com" if is_google_property(d) else d)
    except Exception:
        return False


@typechecked
async def import_signin(domain: str, browser_id: str) -> SessionImportResult:
    """Copy the user's existing sign-in for `domain` into the app's browser partition.

    Never raises: every failure degrades to a result the caller can fall back from, because that
    fallback (ask the user to sign in) is exactly the behaviour that existed before this did.
    """
    d = site_domain(domain)
    if not d:
        return SessionImportResult(outcome="no_session", domain=domain, detail="no domain")

    records = await asyncio.to_thread(read_site_records, d)
    if not records:
        logger.info(f"[session-import] no readable session for {d}")
        return SessionImportResult(outcome="no_session", domain=d,
                                   detail="no session found in your other browsers")

    result = await ws_manager.send_browser_command(
        uuid4().hex, "import_session", browser_id, {"domain": d, "cookies": records})
    if not isinstance(result, dict) or result.get("error"):
        detail = str(result.get("error") if isinstance(result, dict) else result)[:200]
        logger.info(f"[session-import] bridge failed for {d}: {detail}")
        return SessionImportResult(outcome="bridge_failed", domain=d, detail=detail)

    count = int(result.get("set") or 0)
    if count <= 0:
        return SessionImportResult(outcome="no_session", domain=d, detail="nothing applied")
    logger.info(f"[session-import] applied {count} entries for {d}")
    return SessionImportResult(outcome="imported", domain=d, entries_applied=count)
