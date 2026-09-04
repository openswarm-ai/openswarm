"""Assembles what the in-app help chat knows: shipped product facts plus live facts about THIS
install (version, platform, the user's actual shortcuts, whether a model is even connected).

Shipped facts can't drift from the build. Live facts are the part a shipped file can never get
right, and they are exactly where a hardcoded help prompt goes stale first.

The result is handed to the chat as its system prompt, which lands in the provider's cached
prefix (see RunOptions), so the knowledge is paid for once per session rather than per turn.
"""

import platform
from typing import List, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.help.help_topics import HELP_TOPICS, HelpTopic
from backend.apps.help.changelog import help_context_block
from backend.apps.help.known_issues import KNOWN_ISSUES, HelpKnownIssue
from backend.apps.help.prompt_rules import GROUNDING_RULES, ROLE

IS_MAC = platform.system() == "Darwin"

# Off mac these handlers fire on Ctrl (the code reads metaKey||ctrlKey), so "Meta" must READ as Ctrl.
P_MAC_GLYPH = {"meta": "⌘", "ctrl": "⌃", "alt": "⌥", "shift": "⇧"}
P_OTHER_NAME = {"meta": "Ctrl", "ctrl": "Ctrl", "alt": "Alt", "shift": "Shift"}

# Same "Meta+l" parts format the settings fields use, so one renderer covers stock and configured alike.
P_FIXED_SHORTCUTS: List[tuple] = [
    ("Meta+k", "Search everything, across all dashboards"),
    ("Meta+f", "Find cards on this canvas; inside a browser card it finds text on the page"),
    ("Meta+Shift+t", "Reopen the card you just closed"),
    ("Meta+a", "Select every card"),
    ("Meta+c", "Copy the selected cards"),
    ("Meta+v", "Paste the copied cards"),
    ("Delete", "Delete the selected cards"),
    ("Enter", "Expand or collapse the selected chat"),
    ("Meta+Alt+Left", "Previous dashboard"),
    ("Meta+Alt+Right", "Next dashboard"),
    ("Meta+=", "Zoom in; inside a browser card it zooms the page"),
    ("Meta+-", "Zoom out; inside a browser card it zooms the page"),
    ("Meta+0", "Reset zoom"),
    ("Ctrl+Tab", "Next tab in the focused browser card"),
    ("Space", "Hold and drag to pan the canvas"),
    ("Arrows", "Move between cards"),
    ("Escape", "Close the open panel or menu"),
]


class HelpShortcut(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    keys: str
    action: str


class HelpKnowledgeResponse(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    system_prompt: str
    topics: List[HelpTopic]
    known_issues: List[HelpKnownIssue]
    shortcuts: List[HelpShortcut]
    app_version: str


@typechecked
def render_combo(combo: str) -> str:
    """'Meta+Shift+d' -> '⇧⌘D' on mac, 'Ctrl+Shift+D' elsewhere."""
    parts = [p for p in combo.split("+") if p]
    out: List[str] = []
    for part in parts:
        low = part.lower()
        if IS_MAC:
            out.append(P_MAC_GLYPH.get(low, part.upper() if len(part) == 1 else part))
        else:
            out.append(P_OTHER_NAME.get(low, part.upper() if len(part) == 1 else part))
    return ("" if IS_MAC else "+").join(out)


@typechecked
def dictation_default_combo() -> str:
    return "Meta+Shift+d" if IS_MAC else "Ctrl+Shift+d"


@typechecked
def build_shortcuts(new_agent_combo: str, dictation_combo: Optional[str]) -> List[HelpShortcut]:
    live = [
        HelpShortcut(keys=render_combo(new_agent_combo or "Meta+l"), action="Open the new-chat composer"),
        HelpShortcut(keys=render_combo(dictation_combo or dictation_default_combo()), action="Start or stop voice dictation"),
    ]
    return live + [HelpShortcut(keys=render_combo(c), action=a) for c, a in P_FIXED_SHORTCUTS]


@typechecked
def p_provider_state(connected_subscriptions: Optional[List[str]]) -> str:
    """One honest line about whether this install can actually run a model. The subscriptions come
    from the router (None when it cannot say); the settings file's token fields are dead."""
    from backend.apps.settings.store import load_settings

    s = load_settings()
    mode = getattr(s, "connection_mode", "own_key")
    if mode == "free-trial":
        return "on the free trial (a shared capacity pool)"
    if mode == "openswarm-pro":
        return "on an OpenSwarm paid plan"
    keyed = any(
        getattr(s, f, None)
        for f in ("anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key")
    )
    if connected_subscriptions:
        return "on a connected provider subscription"
    if keyed:
        return "on their own API key"
    if connected_subscriptions is None:
        return "in an unknown model state (the app's router is not running, so subscriptions cannot be checked); do not tell them nothing is connected"
    return "with NO model connected yet, so most agent work will fail until they connect one in Settings > Models"


@typechecked
def p_topics_block() -> str:
    lines: List[str] = []
    for t in HELP_TOPICS:
        where = f" WHERE: {t.where}" if t.where else ""
        lines.append(f"- [{t.id}] {t.title}.{where} {t.body}")
    return "\n".join(lines)


@typechecked
def p_issues_block() -> str:
    lines: List[str] = []
    for i in KNOWN_ISSUES:
        fix = f" Workaround: {i.workaround}" if i.workaround else ""
        lines.append(f"- [{i.id}] ({i.status}) {i.title}. {i.detail}{fix}")
    return "\n".join(lines)


@typechecked
def build_system_prompt(shortcuts: List[HelpShortcut], app_version: str, provider_state: str) -> str:
    shortcut_lines = "\n".join(f"- {s.keys}: {s.action}" for s in shortcuts)
    os_name = "macOS" if IS_MAC else platform.system()
    return "\n".join(
        [
            ROLE,
            "",
            "<this_install>",
            f"OpenSwarm version {app_version} on {os_name}. This user is {provider_state}.",
            "These are live facts about the machine you are talking to; trust them over anything you recall.",
            "</this_install>",
            "",
            "<surfaces>",
            "Verified against this exact build. This is your ground truth for where things are.",
            p_topics_block(),
            "</surfaces>",
            "",
            "<shortcuts>",
            "This user's real shortcuts, already written for their platform. Quote them exactly.",
            shortcut_lines,
            "</shortcuts>",
            "",
            "<whats_new>",
            "What actually changed in this build. Answer \"what's new\" from THIS, never from memory.",
            help_context_block(app_version),
            "</whats_new>",
            "",
            "<known_issues>",
            "The complete list of issues shipped with this build. You cannot see live bug reports.",
            p_issues_block(),
            "</known_issues>",
            "",
            GROUNDING_RULES,
        ]
    )


@typechecked
def build_knowledge_response(connected_subscriptions: Optional[List[str]]) -> HelpKnowledgeResponse:
    from backend.apps.service.version import APP_VERSION
    from backend.apps.settings.store import load_settings

    s = load_settings()
    shortcuts = build_shortcuts(
        getattr(s, "new_agent_shortcut", "Meta+l") or "Meta+l",
        getattr(s, "dictation_shortcut", None),
    )
    return HelpKnowledgeResponse(
        system_prompt=build_system_prompt(shortcuts, APP_VERSION, p_provider_state(connected_subscriptions)),
        topics=HELP_TOPICS,
        known_issues=KNOWN_ISSUES,
        shortcuts=shortcuts,
        app_version=APP_VERSION,
    )
