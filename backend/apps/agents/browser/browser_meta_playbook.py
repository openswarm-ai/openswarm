"""
Cross-site meta-playbook (browser memory tier 3).

Tier 2 (`browser_playbook`) learns per-SITE strategy. This tier learns the
SITE-AGNOSTIC patterns that transfer everywhere, e.g. "a composer clears on send,
so the cleared box IS the confirmation; do not hunt the thread for the text" or
"an opener like Message/DM just opens the box, only Send is irreversible". So the
VERY FIRST task on a brand-new site already benefits from what was learned on
every other site, the generalizable answer to "make it learn to learn".

Cheap by construction: the per-site distill (one aux call we already make) ALSO
returns a `universal` list; we just MERGE those here (dedup + cap), NO extra LLM
call. Same fail-safe as the per-site playbook: it is ADVISORY text seeded into the
prompt and re-verified by the agent, never auto-executed, so a wrong universal
bullet can only mildly mislead and is corrected as more sites confirm the truth.
"""

import json
import logging
import os
import tempfile
import time

from backend.apps.agents.browser.browser_playbook import clean_bullet

logger = logging.getLogger(__name__)

P_VERSION = 1
P_MAX_BULLETS = 10          # a touch larger than per-site: these earn their keep everywhere
P_FILE = "meta_playbook.json"

P_CACHE: list[str] | None = None


def p_dir() -> str | None:
    base = os.environ.get("OPENSWARM_BROWSER_META_DIR")
    if not base:
        try:
            from backend.config.paths import DATA_ROOT
            base = os.path.join(DATA_ROOT, "browser_meta")
        except Exception:
            return None
    try:
        os.makedirs(base, mode=0o700, exist_ok=True)
    except Exception:
        return None
    return base


def p_path() -> str | None:
    d = p_dir()
    return os.path.join(d, P_FILE) if d else None


def p_load() -> list[str]:
    path = p_path()
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") != P_VERSION:
            return []
        return [b for b in (data.get("bullets") or []) if isinstance(b, str)]
    except Exception:
        return []


def p_persist(bullets: list[str]) -> None:
    path = p_path()
    if not path:
        return
    try:
        d = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"version": P_VERSION, "bullets": bullets, "updated_at": time.time()}, f)
        os.replace(tmp, path)  # atomic
    except Exception as e:
        logger.debug(f"[browser-meta] persist failed: {e}")


def p_get_meta() -> list[str]:
    """The cross-site bullets (cheap, no LLM). Cached after first read."""
    global P_CACHE
    if P_CACHE is None:
        P_CACHE = p_load() or list(P_SEED)
    return P_CACHE


def format_for_prompt() -> str:
    """The block injected into EVERY run's prompt, or '' if empty. Kept short and
    clearly framed as general priors so it never overrides what the live page shows."""
    bullets = p_get_meta()
    if not bullets:
        return ""
    lines = "\n".join(f"- {b}" for b in bullets[:P_MAX_BULLETS])
    return (
        "\n\n## General web priors (learned across many sites, verify against THIS page)\n"
        + lines
    )


def absorb(universal_bullets: list[str]) -> bool:
    """Merge site-agnostic lessons from a run into the meta-playbook. No LLM call.
    Only GENUINELY new bullets (not already present, case-insensitive) move the
    needle, so a re-confirmed lesson doesn't churn the list. New content goes first
    so it wins the cap over a stale prior. Returns True only if something changed."""
    if not universal_bullets:
        return False
    existing = p_get_meta()
    existing_lower = {b.lower() for b in existing}
    truly_new: list[str] = []
    seen: set[str] = set()
    for b in universal_bullets:
        cb = clean_bullet(b)
        if cb and cb.lower() not in existing_lower and cb.lower() not in seen:
            seen.add(cb.lower())
            truly_new.append(cb)
    if not truly_new:
        return False
    merged = (truly_new + existing)[:P_MAX_BULLETS]
    global P_CACHE
    P_CACHE = merged
    p_persist(merged)
    logger.info(f"[browser-meta] {len(merged)} cross-site prior(s) (was {len(existing)})")
    return True


def clear(wipe_disk: bool = False) -> None:
    """Test/maintenance reset of the in-memory cache (and optionally disk)."""
    global P_CACHE
    P_CACHE = None
    if wipe_disk:
        path = p_path()
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass


# Shipped starting priors: the hard-won universal lessons from this codebase's own
# browser work, so tier 3 is useful on day one and accrues more as sites confirm them.
P_SEED = (
    "A message composer CLEARS when the send goes through; the empty box IS your "
    "confirmation, do not hunt the thread for the sent text to 'verify'.",
    "An opener (Message/DM/Compose) only OPENS the box and is reversible; only the "
    "actual Send/Submit/Post is irreversible, so opening it freely is safe.",
    "If the target's thread/composer is already open, commit to it; do not navigate "
    "away to a profile or re-search just to re-confirm the recipient.",
    "In rich-text composers, Enter usually inserts a newline; click the Send button "
    "rather than pressing Enter.",
    "The Send button often renders a beat AFTER the text commits; settle briefly and "
    "re-list once rather than concluding it vanished and hunting via CSS/JS.",
    "Construct deep search URLs directly (site.com/search?q=...) instead of driving "
    "the homepage search UI when you know the pattern.",
)
