"""Post-run action prompt with sleek, focusable pills.

Shown on a TTY after every run. Drops a compact bubble inline at the bottom of
the terminal (Textual owns the mouse + keyboard) offering four actions: rerun
all, rerun failed, rerun passed, or exit. Inline mode keeps the run's scrollback
above it instead of taking over the whole screen.

Navigate the pills with the arrow keys and press enter to choose, click a pill,
or hit its letter shortcut. Pills whose set is empty (no failures, no passes)
are dimmed and skipped. Styling mirrors the test picker so the surfaces read as
one tool. Kept separate from ``run.py`` so the Rich run path stays Textual-free.

``prompt_actions(...)`` returns the node IDs to rerun, or None to exit.
"""

from __future__ import annotations

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Static

from tests.runner.picker import _THEME

# Keep the inline bubble small: list only a few failures, the rest collapse into
# an "and N more" line. The pill counts still reflect the true totals.
_MAX_LISTED = 6

# On-brand accents for the failure list (theme vars aren't reachable from Rich
# markup, so mirror the picker palette here): coral mark + warm-grey path.
_MARK = "#d97757"   # primary coral
_PATH = "#b0aea6"   # secondary warm grey


class Pill(Static):
    """A compact, focusable, clickable action pill.

    Mirrors the picker's chip look but joins the focus ring so the arrow keys
    can move between pills; ``enter`` (or a click) fires the screen's choose.
    Empty actions are passed ``enabled=False`` -> disabled, dimmed, and skipped
    by focus navigation.
    """

    def __init__(self, key_hint: str, result: str, label: str, *, enabled: bool,
                 primary: bool = False, id: str | None = None) -> None:
        cls = "pill" + (" primary" if primary else "")
        super().__init__(id=id, classes=cls)
        self.key_hint = key_hint
        self.result = result
        self.label_text = label
        self.can_focus = enabled
        self.disabled = not enabled

    def render(self) -> Text:
        return Text.assemble((f"{self.key_hint} ", "bold"), (self.label_text, ""))

    def on_click(self) -> None:
        if not self.disabled:
            self.screen.choose(self.result)


class ActionScreen(Screen):
    CSS = """
    ActionScreen { height: auto; }
    #bubble {
        height: auto;
        width: auto;
        max-width: 100%;
        margin: 0 1;
        padding: 0 1;
        background: $panel;
        border: round $primary;
        border-title-align: left;
    }
    #failbox { height: auto; padding: 0 1; }
    #pills { height: auto; }
    .pill {
        width: auto;
        height: 1;
        margin: 1 1 0 0;
        padding: 0 1;
        color: $text-muted;
        background: $surface-lighten-1;
    }
    .pill:focus { background: $primary; color: $background; text-style: bold; }
    .pill:hover { background: $accent; color: $background; text-style: bold; }
    .pill:disabled { color: $text-disabled; background: $surface; text-opacity: 60%; }
    #hint {
        height: 1;
        margin: 1 0 0 1;
        color: $text-muted;
        text-style: italic;
    }
    """

    BINDINGS = [
        Binding("left", "move(-1)", "Prev", show=False),
        Binding("up", "move(-1)", "Prev", show=False),
        Binding("right", "move(1)", "Next", show=False),
        Binding("down", "move(1)", "Next", show=False),
        Binding("enter", "activate", "Select", priority=True),
        Binding("a", "pick('all')", "Rerun all", show=False),
        Binding("f", "pick('failed')", "Rerun failed", show=False),
        Binding("s", "pick('passed')", "Rerun passed", show=False),
        Binding("q", "pick('exit')", "Exit", show=False, priority=True),
        Binding("escape", "pick('exit')", "Exit", show=False, priority=True),
    ]

    def __init__(self, all_ids: list[str], failed_ids: list[str],
                 passed_ids: list[str]) -> None:
        super().__init__()
        self._all = all_ids
        self._failed = failed_ids
        self._passed = passed_ids
        self._enabled = {
            "all": bool(all_ids),
            "failed": bool(failed_ids),
            "passed": bool(passed_ids),
            "exit": True,
        }

    def compose(self) -> ComposeResult:
        failed = self._failed
        body = Text()
        listed = failed[:_MAX_LISTED]
        for i, nid in enumerate(listed):
            body.append("\u2717 ", style=_MARK)
            body.append(nid, style=_PATH)
            if i < len(listed) - 1:
                body.append("\n")
        hidden = len(failed) - _MAX_LISTED
        if hidden > 0:
            body.append(f"\n\u2026 and {hidden} more", style="dim italic")
        with Vertical(id="bubble"):
            if failed:
                yield Static(body, id="failbox")
            with Horizontal(id="pills"):
                yield Pill("a", "all", f"rerun all ({len(self._all)})",
                           enabled=self._enabled["all"], id="all")
                yield Pill("f", "failed", f"rerun failed ({len(self._failed)})",
                           enabled=self._enabled["failed"], id="failed")
                yield Pill("s", "passed", f"rerun passed ({len(self._passed)})",
                           enabled=self._enabled["passed"], id="passed")
                yield Pill("q", "exit", "exit", enabled=True, id="exit")
            yield Static("\u2190/\u2192 move \u00b7 enter select \u00b7 esc exit", id="hint")

    def on_mount(self) -> None:
        total, npass, nfail = len(self._all), len(self._passed), len(self._failed)
        self.query_one("#bubble", Vertical).border_title = (
            f"\U0001f4a1 {total} run \u00b7 {npass} passed \u00b7 {nfail} failed"
        )
        # Land focus on the most useful default: failures if any, else rerun-all.
        default = "failed" if self._failed else "all"
        self.query_one(f"#{default}", Pill).focus()

    def action_move(self, delta: int) -> None:
        # Step focus between pills; disabled (empty) pills are skipped because
        # they're not in the focus chain. Wraps at the ends.
        if delta < 0:
            self.focus_previous()
        else:
            self.focus_next()

    def choose(self, result: str) -> None:
        self.app.exit(result)

    def action_pick(self, result: str) -> None:
        if self._enabled.get(result, False):
            self.choose(result)

    def action_activate(self) -> None:
        focused = self.focused
        if isinstance(focused, Pill) and not focused.disabled:
            self.choose(focused.result)


class ActionPrompt(App):
    def __init__(self, all_ids: list[str], failed_ids: list[str],
                 passed_ids: list[str]) -> None:
        super().__init__()
        self._all = all_ids
        self._failed = failed_ids
        self._passed = passed_ids

    def on_mount(self) -> None:
        self.register_theme(_THEME)
        self.theme = "picker"
        self.push_screen(ActionScreen(self._all, self._failed, self._passed))


def prompt_actions(all_ids: list[str], failed_ids: list[str],
                   passed_ids: list[str]) -> list[str] | None:
    """Show the inline post-run prompt.

    Returns the node IDs to rerun (rerun-all / failed / passed) or None to exit.
    """
    if not all_ids:
        return None
    # inline=True renders a compact region at the bottom of the existing
    # terminal instead of taking over the whole screen (the alternate buffer).
    choice = ActionPrompt(all_ids, failed_ids, passed_ids).run(inline=True)
    return {
        "all": all_ids,
        "failed": failed_ids,
        "passed": passed_ids,
    }.get(choice)
