"""Deliberate faults, so a guard is proven rather than hoped for.

Half our safety code only runs when something rare goes wrong: a wedged sidecar, a frozen loop,
a provider refusal, a mislabelled 401. Waiting for those in the wild means they are never drilled,
and a guard that never executes is indistinguishable from one that never needed to (the 50KB cap
measured 0.0%, ENG-385; the mid-turn breaker never fires on codex at all, ENG-391).

`OSW_FAULT` is a comma-separated list of faults to arm. Unset in every shipped build, and an
unknown name is ignored rather than guessed at, so a typo can never silently arm nothing while
the drill reports a pass.

    OSW_FAULT=policy_block,auth_401 bash run.sh
"""

import logging
import os
from typing import Set

logger = logging.getLogger(__name__)

# Every fault the harness knows. A name outside this set is a typo, not a feature.
KNOWN_FAULTS: Set[str] = {
    "policy_block",      # the provider declines the request (ENG-383 failover, ENG-387 doors)
    "auth_401",          # a 401 mid-turn (ENG-361 self-heal, ENG-365 must not misread "line 401,")
    "sidecar_wedge",     # a builtin tool never returns (ENG-368 heartbeat ceiling)
    "transport_death",   # the CLI's pipe dies, not the provider (ENG-382 respawn-not-rebuild)
    "empty_finish",      # a turn ends with no answer after tool work (ENG-354, ENG-390)
}


def armed(name: str) -> bool:
    """True when this fault was deliberately armed. Never true in a shipped build."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw:
        return False
    wanted = {p.strip() for p in raw.split(",") if p.strip()}
    return name in (wanted & KNOWN_FAULTS)


_FIRED: Set[str] = set()


def armed_once(name: str) -> bool:
    """Fire a recoverable fault exactly ONCE per process.

    A fault that fires on every turn cannot drill a recovery: the retry hits the same wall and the
    drill only ever proves the failure, never the heal. Recoverable classes (a dead pipe, a rotated
    token) want one hit and then a clear road."""
    if not armed(name) or name in _FIRED:
        return False
    _FIRED.add(name)
    return True


def reset_fired() -> None:
    """Test-only: forget what has fired so a case can arm the same one-shot again."""
    _FIRED.clear()


def unknown_faults() -> Set[str]:
    """Names asked for that this build does not know: surfaced loudly so a typo cannot read as a pass."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw:
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()} - KNOWN_FAULTS


def announce() -> None:
    """Say out loud, once at boot, that this process will inject failures, and name any word that
    armed nothing. Silence here is the exact row-6 shape this module exists to kill: a typo arms
    NOTHING, the drill then exercises the untouched happy path, and the pass is meaningless."""
    raw = os.environ.get("OSW_FAULT", "")
    if not raw.strip():
        return
    live = sorted({p.strip() for p in raw.split(",") if p.strip()} & KNOWN_FAULTS)
    bogus = sorted(unknown_faults())
    logger.warning(
        "OSW_FAULT is set: this process will DELIBERATELY INJECT failures. "
        f"armed={live or 'NOTHING'}"
        + (f"; not a known fault, armed nothing: {bogus}" if bogus else "")
    )
