"""Self-heal before bothering the user: when a URL-bearing watcher (web/stream)
starts failing, one invisible background agent turn investigates and either
fixes the config itself (a moved/redirected URL) or declares it needs a human,
at which point the attention surface takes over. Strict FIX_URL / CANNOT_FIX
contract; only an http(s) URL that actually differs is ever applied, and the
repair is written to the activity log so nothing changes silently."""

import logging
from typing import Optional, Tuple

from typeguard import typechecked

from backend.apps.events.models import EventLogEntry, EventTriggerConfig

logger = logging.getLogger(__name__)


@typechecked
def build_heal_prompt(url: str, last_error: str) -> str:
    return (
        "You are repairing an automated watcher. It repeatedly fails to read this URL:\n"
        f"{url}\n"
        f"Most recent error: {last_error or 'unknown'}\n\n"
        "Investigate with your tools (fetch the URL, follow redirects, check for an obvious "
        "moved/renamed location on the same site). Then END your reply with EXACTLY one of:\n"
        "FIX_URL: <a working replacement URL>\n"
        "CANNOT_FIX: <one line saying what a human needs to do>"
    )


@typechecked
def parse_heal_reply(text: str) -> Tuple[Optional[str], str]:
    """(replacement url or None, reason). Last occurrence wins."""
    fix: Optional[str] = None
    reason = ""
    for line in text.splitlines():
        s = line.strip()
        if s.upper().startswith("FIX_URL:"):
            fix = s[len("FIX_URL:"):].strip()
            reason = ""
        elif s.upper().startswith("CANNOT_FIX:"):
            fix = None
            reason = s[len("CANNOT_FIX:"):].strip()
    return fix, reason


async def probe_url(url: str) -> bool:
    """A heal is only real if the fix demonstrably answers: SSRF-guarded GET, 2xx/3xx required. Model claims never applied unverified."""
    try:
        from backend.apps.agents.tools.web import USER_AGENT, safe_fetch
        resp = await safe_fetch(url, method="GET", headers={"User-Agent": USER_AGENT}, timeout=12.0)
        return resp.status_code < 400
    except Exception:
        return False


async def attempt_heal(workflow_id: str, trigger: EventTriggerConfig) -> bool:
    """True when the trigger config was repaired (caller should re-poll now)."""
    from backend.apps.events import stores
    from backend.apps.events.adapters.agent_check import run_check_turn
    from backend.apps.settings.settings import load_settings
    from backend.apps.workflows import storage

    url = str(getattr(trigger.source, "url", "") or "").strip()
    if not url:
        return False
    health = stores.read_poll_health(trigger.id)
    model = getattr(load_settings(), "default_model", None) or "sonnet"
    try:
        reply = await run_check_turn(model, build_heal_prompt(url, str(health.get("last_error") or "")))
        fix, reason = parse_heal_reply(reply)
    except Exception as e:
        logger.warning("heal turn failed for trigger %s: %s", trigger.id, e)
        return False
    if fix and fix.startswith("http") and fix != url:
        if not await probe_url(fix):
            stores.append_log(workflow_id, EventLogEntry(
                trigger_id=trigger.id, kind="error",
                summary=f"Self-heal proposed {fix} but it didn't answer; not applied",
            ))
            return False
        wf = storage.get_workflow(workflow_id)
        if wf is None:
            return False
        live = next((t for t in wf.event_triggers if t.id == trigger.id), None)
        if live is None or str(getattr(live.source, "url", "")) != url:
            return False  # user edited it meanwhile; their change wins
        setattr(live.source, "url", fix)
        storage.save_workflow(wf)
        stores.clear_poll_failures(trigger.id)
        stores.append_log(workflow_id, EventLogEntry(
            trigger_id=trigger.id, kind="emitted",
            summary=f"Self-healed: watcher URL updated to {fix}",
        ))
        return True
    stores.append_log(workflow_id, EventLogEntry(
        trigger_id=trigger.id, kind="error",
        summary=f"Self-heal couldn't fix it: {reason[:160] or 'no working replacement found'}",
    ))
    return False
