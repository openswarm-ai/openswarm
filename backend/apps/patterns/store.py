"""On-disk store for pattern suggestions under DATA_ROOT/patterns/:
  suggestions.json   every suggestion ever made (pending/accepted/dismissed)
  state.json         miner bookkeeping (last_mined_at)
"""

import os
from datetime import datetime
from typing import List, Optional

from typeguard import typechecked

from backend.apps.patterns.models import WorkflowSuggestion
from backend.config.json_store import atomic_write_json, read_json_or_none
from backend.config.paths import DATA_ROOT

PATTERNS_DIR = os.path.join(DATA_ROOT, "patterns")
SUGGESTIONS_FILE = os.path.join(PATTERNS_DIR, "suggestions.json")
STATE_FILE = os.path.join(PATTERNS_DIR, "state.json")

MAX_SUGGESTIONS = 100


@typechecked
def load_suggestions() -> List[WorkflowSuggestion]:
    raw = read_json_or_none(SUGGESTIONS_FILE)
    if not isinstance(raw, list):
        return []
    out: List[WorkflowSuggestion] = []
    for item in raw:
        try:
            out.append(WorkflowSuggestion(**item))
        except Exception:
            continue
    return out


@typechecked
def save_suggestions(suggestions: List[WorkflowSuggestion]) -> None:
    # Oldest rows fall off first; dismissed signatures are re-derivable from what remains.
    bounded = suggestions[-MAX_SUGGESTIONS:]
    atomic_write_json(SUGGESTIONS_FILE, [s.model_dump(mode="json") for s in bounded])


@typechecked
def get_suggestion(suggestion_id: str) -> Optional[WorkflowSuggestion]:
    for s in load_suggestions():
        if s.id == suggestion_id:
            return s
    return None


@typechecked
def update_suggestion(updated: WorkflowSuggestion) -> None:
    suggestions = load_suggestions()
    for i, s in enumerate(suggestions):
        if s.id == updated.id:
            suggestions[i] = updated
            break
    else:
        suggestions.append(updated)
    save_suggestions(suggestions)


@typechecked
def pending_suggestions() -> List[WorkflowSuggestion]:
    return [s for s in load_suggestions() if s.status == "pending"]


@typechecked
def known_signatures() -> List[str]:
    """Signatures of everything already offered, in any state; the miner never re-proposes anything similar."""
    return [s.signature for s in load_suggestions() if s.signature]


@typechecked
def dismissed_descriptions() -> List[str]:
    return [s.description for s in load_suggestions() if s.status == "dismissed"]


@typechecked
def last_mined_at() -> Optional[datetime]:
    raw = read_json_or_none(STATE_FILE) or {}
    stamp = raw.get("last_mined_at")
    if not isinstance(stamp, str):
        return None
    try:
        return datetime.fromisoformat(stamp)
    except ValueError:
        return None


@typechecked
def set_last_mined_at(when: datetime) -> None:
    atomic_write_json(STATE_FILE, {"last_mined_at": when.isoformat()})
