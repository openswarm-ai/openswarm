"""The router's history pruner must never disable itself in silence.

`9router_gpt5_patch.js` loads the pruner eagerly and writes one verdict line to stderr at boot. In a
packaged build that stderr lands only in the router start log, which nothing read, so a pruner that
failed to load looked identical to one that was working. This reads the verdict after a successful
start and says, loudly, what every chat on the machine just lost.
"""
import logging
from typing import Literal
from typeguard import typechecked

logger = logging.getLogger(__name__)
HistoryPruneState = Literal["installed", "failed", "unknown"]
P_INSTALLED_LINE = "[history-prune] installed"
P_FAILED_LINE = "[history-prune] FAILED to load"


@typechecked
def history_prune_state(log_path: str) -> HistoryPruneState:
    try:
        with open(log_path, "rb") as f:
            text = f.read(200_000).decode("utf-8", errors="replace")
    except OSError:
        return "unknown"
    if P_FAILED_LINE in text:
        return "failed"
    if P_INSTALLED_LINE in text:
        return "installed"
    return "unknown"


@typechecked
def report_history_prune_state(log_path: str, packaged: bool) -> HistoryPruneState:
    """Packaged builds capture the router's stderr, so silence there means the patch never loaded (the
    `--require` flag is dropped when the patch file is missing). Dev sends stderr to DEVNULL, so
    silence there is just silence."""
    state = history_prune_state(log_path)
    if state == "installed":
        logger.info("9Router history pruner installed")
        return state
    if not packaged:
        logger.debug("9Router history pruner state unknown (stderr not captured in dev)")
        return state
    logger.warning(
        "9Router history pruner %s: every chat on this machine now resends its FULL tool history "
        "on every step, so long chats will hit the context wall (the autocompact-thrash class). "
        "Router start log: %s",
        "FAILED to load" if state == "failed" else "never announced itself (patch not loaded?)",
        log_path,
    )
    try:
        from backend.apps.service.client import submit_diagnostic
        submit_diagnostic({"kind": "router", "subkind": f"history_prune_{state}", "log_path": log_path})
    except Exception:
        logger.debug("submit_diagnostic history_prune_state failed", exc_info=True)
    return state
