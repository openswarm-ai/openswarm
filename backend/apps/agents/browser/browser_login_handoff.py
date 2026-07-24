"""Login-once handoff: when the browser agent lands on a login wall, it pauses for the user to
sign in ONCE in the app's browser card, then continues, and we REMEMBER which sites the user has
authenticated so future runs skip the prompt and only re-ask on a genuine expiry or a different
account. The session itself lives in Electron's persist:openswarm-browser partition (which keeps
it across quits, so "sign in once, never again" is really the partition's doing); this module is
the durable memory of it plus the detection and the wording, keyed by registrable domain.

Detection reuses the one structural login-wall definition in browser_send_parse, so the pause and
the send-script's decline can never disagree about what a login wall is.
"""

import datetime
import os
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

from typeguard import typechecked

from backend.apps.agents.browser import browser_send_parse
from backend.config.json_store import atomic_write_json, read_json_or_none
from backend.config.paths import SETTINGS_DIR

P_STORE_PATH = os.path.join(SETTINGS_DIR, "authenticated_domains.json")


@typechecked
def registrable_domain(url_or_host: str) -> str:
    s = (url_or_host or "").strip()
    host = urlparse(s).hostname if "://" in s else s.split("/")[0]
    host = (host or "").lower().strip().lstrip(".").split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host


@typechecked
def p_load() -> Dict[str, Dict[str, str]]:
    data = read_json_or_none(P_STORE_PATH)
    return data if isinstance(data, dict) else {}


@typechecked
def is_authenticated(url_or_host: str) -> bool:
    return registrable_domain(url_or_host) in p_load()


@typechecked
def authenticated_domains() -> List[str]:
    return sorted(p_load().keys())


@typechecked
def login_record(url_or_host: str) -> Optional[Dict[str, str]]:
    """The stored {first_seen, last_login} for a site, or None. For a future 'signed-in sites' view."""
    return p_load().get(registrable_domain(url_or_host))


@typechecked
def record_login(url_or_host: str) -> None:
    """Remember that the user signed into this site, so future walls read as re-auth not first-run.
    Fail-open: a write error just means the next run treats it as a fresh sign-in (harmless)."""
    d = registrable_domain(url_or_host)
    if not d:
        return
    store = p_load()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    prior = store.get(d) or {}
    store[d] = {"first_seen": prior.get("first_seen") or now, "last_login": now}
    try:
        atomic_write_json(P_STORE_PATH, store)
    except OSError:
        pass


@typechecked
def login_wall_domain(current_url: str, state_text: str) -> Optional[str]:
    """The registrable domain of a login wall the agent is stuck on, or None. One definition of
    'login wall', shared with the send-script's decline gate."""
    if not browser_send_parse.looks_like_login_wall(current_url or "", state_text or ""):
        return None
    return registrable_domain(current_url) or None


@typechecked
def prompt_copy(domain: str) -> Tuple[str, str]:
    """(problem, instruction) for the pause overlay, worded by whether the user has signed into
    this site before (re-auth) or it's a first sign-in."""
    if is_authenticated(domain):
        problem = f"Your {domain} sign-in looks signed out, it may have expired or be a different account."
    else:
        problem = f"{domain} needs you to sign in before I can keep going."
    instruction = "Log in to the site in the browser above, then click Done and I'll pick up right where I left off."
    return problem, instruction
