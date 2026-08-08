"""The release story, in one place, for three surfaces: the in-app What's New card, the GitHub
release body, and the Help agent's context. One source means the agent can never answer from a
stale picture of the app, and a release can never ship with no story."""

from typing import Dict, List

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked


class ReleaseNote(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    version: str
    headline: str
    # User-facing lines only: what changed for the person using the app, not the diff.
    highlights: List[str]
    fixes: List[str]


P_RELEASES: List[ReleaseNote] = [
    # Only lines that are true of the built app belong here. This one file feeds the in-app card, the
    # GitHub body AND the Help agent's context, so a line written for a planned feature becomes the
    # agent confidently describing something that does not exist.
    ReleaseNote(
        version="1.7.5",
        headline="Off means off, and the canvas stops tearing.",
        highlights=[
            "Deleting a scheduled workflow makes it stay deleted. One that was mid-run could previously save itself back and keep firing.",
            "Switching a workflow off now stops everything: no queued catch-up runs, nothing waiting on the review card.",
            "Scrolling inside a panel, list, or window stays in that panel instead of dragging the canvas with it.",
            "Opening a busy dashboard no longer locks the window while its cards wake up.",
        ],
        fixes=[
            "The canvas background no longer tears into a hard-edged rectangle when lots of browsers are open.",
            "Editing a workflow step can no longer hang the editor when the naming service is slow.",
            "A crashed session no longer leaves a key watcher running, which made dictation start and immediately stop.",
            "The first message after opening a chat reuses the warmed-up connection, so it answers sooner.",
            "A provider hiccup that fixes itself no longer shows a scary reconnect card.",
        ],
    ),
    ReleaseNote(
        version="1.7.4",
        headline="Chats survive a hiccup instead of stopping.",
        highlights=[
            "A dropped local connection retries and resumes the same answer instead of failing the message.",
            "The spawn composer steps aside when a window is open.",
        ],
        fixes=[
            "App previews reconnect on their own after a backend restart.",
            "Dictation cue sounds default to a level you can actually hear.",
        ],
    ),
]


@typechecked
def release_notes(version: str) -> ReleaseNote | None:
    for note in P_RELEASES:
        if note.version == version:
            return note
    return None


@typechecked
def latest_release() -> ReleaseNote:
    return P_RELEASES[0]


@typechecked
def as_markdown(note: ReleaseNote) -> str:
    """The GitHub release body; identical words to the in-app card, so nobody reads two stories."""
    lines = [f"## {note.version}: {note.headline}", ""]
    if note.highlights:
        lines.append("### New")
        lines += [f"- {h}" for h in note.highlights]
        lines.append("")
    if note.fixes:
        lines.append("### Fixed")
        lines += [f"- {f}" for f in note.fixes]
    return "\n".join(lines).strip()


@typechecked
def help_context_block(app_version: str) -> str:
    """What the Help agent must know about what just changed, so "what's new" is never stale."""
    note = release_notes(app_version) or latest_release()
    body = [f"Version {note.version}: {note.headline}"]
    body += [f"- new: {h}" for h in note.highlights]
    body += [f"- fixed: {f}" for f in note.fixes]
    return "\n".join(body)


@typechecked
def all_versions() -> Dict[str, str]:
    return {n.version: n.headline for n in P_RELEASES}
