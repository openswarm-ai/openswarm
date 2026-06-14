"""Interactive Textual tree picker.

Renders the discovered test tree with a left disclosure chevron and a row of
run-option toggles (coverage, stop-on-first-fail, last-failed, failed-first,
verbose). Returns ``(node_ids, RunOptions)`` for the selection or ``None`` if
cancelled. Selecting a branch selects all descendant leaves. Selection is shown
fzf-style by recolouring the row rather than with a per-row checkbox: coral for
a fully selected row, a lighter coral when only some descendant leaves are
selected, and the default ink otherwise.

The run options live in a single header toolbar: each flag is a pill
(:class:`FlagChip`) whose fill shows on/off and whose click fires the same
``action_toggle_*`` method as its key binding. The search bar above it is a
flexible inline ``Input`` that visually filters the tree live as you type:
every keystroke prunes the tree to the directories, files, and tests whose
names contain the query (a branch survives if it or any descendant matches), so
the tree shows only what you're looking for. The single-key tree bindings are
gated via ``check_action`` so they go quiet while that ``Input`` is focused,
letting you type queries (spaces, ``a``, ``q``, arrows) without the priority
bindings firing.
"""

from __future__ import annotations

from rich.cells import cell_len
from rich.markup import escape
from rich.segment import Segment
from rich.style import Style
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.color import Color
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.screen import Screen
from textual.strip import Strip
from textual.theme import Theme
from textual.widgets import Input, Static, Tree
from textual.widgets.tree import TreeNode

from tests.runner.config import load_config
from tests.runner.run import RunOptions
from tests.runner.tree import TNode, build_tree

# --- config-driven glyph sets -----------------------------------------------
# The `icons` config key names a *ceiling* tier; each glyph slot below resolves
# to the fanciest variant at or under that ceiling. Tiers are ranked so a
# machine without a patched Nerd Font (or without emoji width support) drops
# gracefully to the next variant per icon instead of rendering tofu. Fonts
# can't be shipped with the tool, so "unicode" (plain BMP shapes) is the safe
# default and "nerd"/"emoji" are opt-in upgrades.
_TIER_RANK = {"ascii": 0, "unicode": 1, "emoji": 2, "nerd": 3}

# Per-slot variants, ordered by the user's preference (fanciest first). Every
# slot defines an "ascii" floor so resolution against any ceiling succeeds.
#   select:  (empty, partial, full)   selection-count readout glyph
#   chevron: (collapsed, expanded)    left-of-row expand indicator
#   dot:     single glyph             selected-row right marker
#   search:  single glyph             search-box title
_ICON_VARIANTS: dict[str, dict[str, object]] = {
    "select": {
        # md checkbox-blank-outline / -intermediate / -marked
        "nerd": ("\U000f0131", "\U000f0856", "\U000f0132"),
        "unicode": ("\u25cb", "\u25d0", "\u25cf"),  # ○ ◐ ●
        "ascii": ("[ ]", "[~]", "[x]"),
    },
    "chevron": {
        "nerd": ("\uf07b", "\uf07c"),  # fa folder / folder-open
        "emoji": ("\U0001f4c1", "\U0001f4c2"),  # 📁 📂
        # Solid triangles read "bigger" than thin chevrons and render anywhere.
        "unicode": ("\u25b6", "\u25bc"),  # ▶ ▼
        "ascii": (">", "v"),
    },
    "dot": {
        # Filled circle, rendered at ~half opacity so it stays subtle (see
        # _DOT_INK). The nerd "circle-medium" is a touch smaller than the
        # unicode ● and sits centred in the cell.
        "nerd": "\U000f09de",  # md circle-medium
        "unicode": "\u25cf",   # ●
        "ascii": "*",
    },
    "search": {
        "nerd": "\uf002",  # fa-search
        "emoji": "\U0001f50d",  # 🔍
        "unicode": "\u2315",  # ⌕
        "ascii": "/",
    },
}


def _resolve_icons(tier: str) -> dict[str, object]:
    """Pick each slot's fanciest variant whose tier rank is <= the ceiling."""
    ceil = _TIER_RANK.get(tier, _TIER_RANK["unicode"])
    chosen: dict[str, object] = {}
    for slot, variants in _ICON_VARIANTS.items():
        best_rank, best = -1, None
        for name, glyph in variants.items():
            rank = _TIER_RANK[name]
            if best_rank < rank <= ceil:
                best_rank, best = rank, glyph
        chosen[slot] = best
    return chosen


_ICONS = _resolve_icons(load_config().icons)
# Only the empty/full glyphs are used now (the selection-count readout); the
# per-row tri-state lives in row colour, not a glyph, so partial is unpacked away.
_SEL_EMPTY, _, _SEL_FULL = _ICONS["select"]
_CHEV_CLOSED, _CHEV_OPEN = _ICONS["chevron"]
_SEL_DOT: str = _ICONS["dot"]
_SEARCH_ICON: str = _ICONS["search"]
# Wide variants (emoji) occupy two cells; precompute so the leaf padding that
# aligns names under the chevron, and the right-pin maths for the selected-row
# dot, reserve the correct width per active tier.
_CHEV_W = cell_len(_CHEV_CLOSED)
_SEL_DOT_W = cell_len(_SEL_DOT)

# Toolbar flag pills: (key hint, screen action, short label). Order = left→right.
# The search bar sits on its own row above this toolbar (it filters the tree).
_FLAGS: list[tuple[str, str, str]] = [
    ("c", "toggle_cov", "cov"),
    ("x", "toggle_x", "stop"),
    ("l", "toggle_lf", "lf"),
    ("f", "toggle_ff", "ff"),
    ("v", "toggle_v", "-v"),
    ("s", "toggle_s", "-s"),
    ("o", "toggle_o", "out"),
]

# Warm "Anthropic dark" palette: coral accent, warm off-white text (no blue
# cast), and warm-charcoal neutrals so the picker reads as one on-brand tool.
_THEME = Theme(
    name="picker",
    primary="#d97757",     # Anthropic coral (the "on"/active accent)
    secondary="#b0aea6",   # warm grey
    accent="#e0a07e",      # lighter coral (hover)
    foreground="#f0eee6",  # warm off-white, deliberately not blue
    background="#1f1e1d",  # warm near-black
    success="#c08a5e",     # warm amber-coral (kept on-brand, not green)
    warning="#d9a24e",
    error="#bf4d43",
    surface="#2a2926",     # warm dark grey (chip/search base)
    panel="#262624",       # warm charcoal (header + toolbar)
    dark=True,
)

# Warm muted grey for unselected rows, so they recede; selected rows use the
# theme coral (_THEME.primary for a full row, _THEME.accent for a partial one).
# The left-side chevrons get a brighter warm grey so they stay legible against
# the dark tree background.
_INK_DIM = "#7a756b"
_CHEV_INK = "#b0aea6"
# Selected rows get a soft coral-tinted background wash (a few shades up from
# the near-black background, warm so it reads as "picked" without shouting) and
# a dot pinned a couple cells in from the right edge.
_SEL_BG = "#3a2b23"
_SEL_BG_STYLE = Style(bgcolor=_SEL_BG)
# When the cursor sits on an already-selected row we keep the wash but nudge it
# a touch lighter, so the current row stays distinct without losing its
# "selected" background entirely.
_SEL_BG_CURSOR_STYLE = Style(bgcolor=Color.parse(_SEL_BG).lighten(0.08).hex)
# Selected-row dot ink: the coral blended halfway into the wash, so the marker
# reads as a soft, roughly half-opacity circle rather than a hard pip.
_DOT_INK = Color.parse(_THEME.primary).blend(Color.parse(_SEL_BG), 0.5).hex
# Cells of clearance between the dot and the right content edge.
_DOT_MARGIN = 3


class PickerTree(Tree):
    """Test tree whose only left marker is a disclosure chevron.

    Textual draws ``ICON_NODE`` / ``ICON_NODE_EXPANDED`` to the left of every
    expandable row; we blank them and add our own chevron in ``render_label``
    so the glyph follows the config-driven icon tier.

    The chevron sits at the hierarchy spine, just after the indent guides:
    expandable rows get ``▶``/``▼`` and leaves get an equal-width blank, so
    every name starts in the same column regardless of node kind.

    Selection has three layers, all keyed off ``sel_state`` (kept in sync by
    ``PickerScreen._refresh_labels``): the name colour (set on the label),
    a right-pinned dot (added in ``render_label``), and a full-width background
    wash that covers the indent gutter too (painted in ``render_line``).
    """

    ICON_NODE = ""
    ICON_NODE_EXPANDED = ""

    # Per-node selection level ("none" / "partial" / "full"), kept in sync by
    # PickerScreen._refresh_labels and read here to draw the selected-row dot
    # and background wash (render time is the only place the row width is known).
    sel_state: dict[TreeNode, str] = {}

    def render_label(self, node: TreeNode, base_style, style) -> Text:
        label = super().render_label(node, base_style, style)
        # Prefix a fixed-width disclosure gutter so names line up: the chevron
        # for expandable rows, an equal-width blank for leaves.
        if node._allow_expand:
            chev = _CHEV_OPEN if node.is_expanded else _CHEV_CLOSED
            prefix = Text.assemble((chev, _CHEV_INK), " ")
        else:
            prefix = Text(" " * (_CHEV_W + 1))
        prefix.append_text(label)
        label = prefix

        if self.sel_state.get(node, "none") == "none":
            return label
        # Selected rows: a right-pinned dot. The full-width background wash is
        # painted in render_line instead, since it has to cover the indent
        # gutter too (drawn by Textual outside the label).
        width = self.size.width
        if width <= 0:
            # Pre-layout probe: trail the dot; it right-pins on the next render.
            label.append(f"  {_SEL_DOT}", _DOT_INK)
            return label
        try:
            guide = self._tree_lines[node._line]._get_guide_width(
                self.guide_depth, self.show_root
            )
        except (IndexError, AttributeError):
            guide = 0
        pad = max(1, width - guide - label.cell_len - _SEL_DOT_W - _DOT_MARGIN)
        label.append(" " * pad)
        label.append(_SEL_DOT, _DOT_INK)
        return label

    def render_line(self, y: int) -> Strip:
        strip = super().render_line(y)
        # Paint the selected-row wash across the FULL row width (indent gutter
        # included), layering the background over each segment so it overrides
        # the tree's own background and reaches both edges. Unselected rows are
        # left untouched (the cursor keeps its default highlight); a selected
        # row under the cursor keeps the wash but a touch lighter.
        line_index = y + self.scroll_offset.y
        tree_lines = self._tree_lines
        if not (0 <= line_index < len(tree_lines)):
            return strip
        node = tree_lines[line_index].path[-1]
        if self.sel_state.get(node, "none") == "none":
            return strip
        bg = (
            _SEL_BG_CURSOR_STYLE if line_index == self.cursor_line else _SEL_BG_STYLE
        )
        washed = [
            Segment(text, (seg_style + bg) if seg_style else bg, control)
            for text, seg_style, control in strip
        ]
        return Strip(washed, strip.cell_length)


class FlagChip(Static):
    """A clickable run-option pill. Fill = on/off; click fires the screen action.

    Click and keyboard share one path: the chip just calls the same
    ``action_<name>`` method the key binding does, and that method flips the
    boolean and re-applies every chip's ``on`` class via ``_refresh_status``.
    Kept out of the focus ring (``can_focus = False``) so it never competes with
    the tree or the search bar for keystrokes.
    """

    def __init__(self, key_hint: str, action_name: str, label: str) -> None:
        super().__init__(classes="chip")
        self.key_hint = key_hint
        self.action_name = action_name
        self.label_text = label
        self.can_focus = False

    def render(self) -> Text:
        return Text.assemble((f"{self.key_hint} ", "bold"), (self.label_text, ""))

    def on_click(self) -> None:
        getattr(self.screen, f"action_{self.action_name}")()


class HelpBadge(Static):
    """Floating bottom-right help.

    Collapsed it's a single ``? Help`` pill; expanded it shows the full key
    legend that used to live in the always-on Footer. Click or the ``?`` key
    toggles it, and it floats on the ``overlay`` layer so it never reserves a
    row or steals focus from the tree.
    """

    expanded = reactive(False)

    # (key hint, description) rows shown when expanded. Curated from BINDINGS
    # with friendlier labels and the arrow pair merged into one line.
    _ITEMS: list[tuple[str, str]] = [
        ("space", "select"),
        ("\u2190 / \u2192", "collapse / expand"),
        ("a", "select all"),
        ("enter", "run"),
        ("k", "search / filter"),
        ("c", "coverage"),
        ("x", "stop on first fail"),
        ("l", "last-failed"),
        ("f", "failed-first"),
        ("v", "verbose"),
        ("s", "stdout"),
        ("o", "output"),
        ("esc", "quit"),
    ]

    def __init__(self) -> None:
        super().__init__(id="help")
        self.can_focus = False

    def render(self) -> Text:
        if not self.expanded:
            return Text.assemble(("? ", f"bold {_THEME.primary}"), ("Help", "bold"))
        lines = [Text("Help", style="bold")]
        for key, desc in self._ITEMS:
            lines.append(
                Text.assemble((f"{key:>9}  ", f"bold {_THEME.primary}"), (desc, ""))
            )
        lines.append(Text("? / click to close", style=_INK_DIM))
        return Text("\n").join(lines)

    def on_click(self) -> None:
        self.expanded = not self.expanded

    def watch_expanded(self, value: bool) -> None:
        self.set_class(value, "open")
        self.refresh(layout=True)


# --- visual tree filtering --------------------------------------------------
def _prune(node: TNode, needle: str) -> TNode | None:
    """Return ``node`` filtered to the branches matching ``needle`` (or ``None``).

    A node whose own label matches is kept whole, so you can still drill into
    its subtree. A non-matching branch survives only if some descendant matches,
    carrying just those matching descendants. Originals are never mutated: a
    whole-subtree keep reuses the existing node by reference, and a partial keep
    builds a fresh ``TNode`` around the surviving children.
    """
    if needle in node.label.lower():
        return node
    if node.is_leaf:
        return None
    kept = [p for c in node.children if (p := _prune(c, needle)) is not None]
    if not kept:
        return None
    return TNode(node.label, node.kind, node.node_id, kept)


def _filter_tree(root: TNode, query: str) -> TNode:
    """Prune ``root``'s children by ``query``; a blank query returns it unchanged."""
    needle = query.strip().lower()
    if not needle:
        return root
    kept = [p for c in root.children if (p := _prune(c, needle)) is not None]
    return TNode(root.label, root.kind, root.node_id, kept)


class PickerScreen(Screen):
    CSS = """
    Screen { layers: base overlay; }
    Tree { padding: 0 1; }
    #panel {
        height: auto;
        margin: 0 1;
        padding: 0 1;
        background: $panel;
        border: round $primary;
        border-title-align: center;
        border-subtitle-align: center;
    }
    #kw-input {
        width: 1fr;
        height: 3;
        margin: 0;
        padding: 0 1;
        border: round $surface-lighten-2;
        background: $background;
        color: $text;
    }
    #kw-input:focus { border: round $accent; background: $surface-darken-1; }
    #toolbar { height: 1; }
    #sel {
        dock: right;
        width: auto;
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    #sel.active { color: $primary; text-style: bold; }
    .chip {
        width: auto;
        height: 1;
        margin: 0 1 0 0;
        padding: 0 1;
        color: $text-muted;
        background: $surface-lighten-1;
    }
    .chip:hover { background: $accent; color: $background; text-style: bold; }
    .chip.on { background: $primary; color: $background; text-style: bold; }
    #help {
        layer: overlay;
        /* overlay: screen removes the badge from the layout flow entirely, so it
           floats over the tree instead of reserving a row / shrinking it. It is
           content-sized (width/height auto) and pinned to the bottom-right by a
           large offset that `constrain: inside` clamps flush to the corner. */
        overlay: screen;
        constrain: inside;
        offset: 9999 9999;
        width: auto;
        height: auto;
        max-width: 60%;
        padding: 0 1;
        color: $text-muted;
        /* Fill is the screen background itself, so there's no distinct box: just
           a coral rounded border drawn straight on the parent background (like
           the search bar). Because the fill equals the parent, the round corners
           have nothing to bleed past, so they read cleanly with no notch. Hover
           brightens the outline + text rather than introducing a contrasting
           fill. */
        background: $background;
        border: round $primary;
    }
    #help:hover { border: round $accent; color: $text; text-style: bold; }
    #help.open {
        padding: 1 2;
        color: $text;
        background: $background;
    }
    """

    # Priority bindings that must go quiet while the search Input is focused, so
    # typing spaces / a / q / arrows / enter edits the field instead of driving
    # the tree. Gated in check_action; escape stays live to blur back to tree.
    _INPUT_BLOCKED = frozenset(
        {
            "toggle_select",
            "expand_node",
            "collapse_node",
            "toggle_all",
            "run",
            "cancel",
            "toggle_help",
        }
    )

    BINDINGS = [
        Binding("space", "toggle_select", "Select", priority=True),
        Binding("right", "expand_node", "Expand", priority=True),
        Binding("left", "collapse_node", "Collapse", priority=True),
        Binding("a", "toggle_all", "All", priority=True),
        Binding("enter", "run", "Run", priority=True),
        Binding("c", "toggle_cov", "cov"),
        Binding("x", "toggle_x", "stop"),
        Binding("l", "toggle_lf", "last-fail"),
        Binding("f", "toggle_ff", "fail-first"),
        Binding("v", "toggle_v", "verbose"),
        Binding("s", "toggle_s", "stdout"),
        Binding("o", "toggle_o", "output"),
        Binding("k", "search", "search"),
        Binding("question_mark", "toggle_help", "Help"),
        Binding("q", "cancel", "Quit", priority=True),
        Binding("escape", "blur_or_cancel", "Quit", priority=True),
    ]

    def __init__(self, root: TNode, opts: RunOptions) -> None:
        super().__init__()
        self._root = root
        self.selected: set[str] = set()
        self._leaf_id: dict[TreeNode, str] = {}
        self._base_label: dict[TreeNode, str] = {}
        self._kind: dict[TreeNode, str] = {}
        # Run-option state, seeded from the CLI flags.
        self.cov = opts.cov
        self.exitfirst = opts.exitfirst
        self.last_failed = opts.last_failed
        self.failed_first = opts.failed_first
        self.verbose = opts.verbose
        self.no_capture = opts.no_capture
        self.show_output = opts.show_output
        # True while the search box holds a non-empty query (tree is pruned).
        self._filter_active = False

    def compose(self) -> ComposeResult:
        with Vertical(id="panel"):
            yield Input(
                value="",
                placeholder="type to filter the tree (e.g. auth, ingest, router)",
                id="kw-input",
            )
            with Horizontal(id="toolbar"):
                yield Static(id="sel")
                for key, action, label in _FLAGS:
                    yield FlagChip(key, action, label)
        tree = PickerTree(self._root.label, id="tree")
        tree.root.expand()
        self._base_label[tree.root] = self._root.label
        self._kind[tree.root] = self._root.kind
        self._build(tree.root, self._root)
        self._refresh_labels(tree)
        yield tree
        yield HelpBadge()

    def on_mount(self) -> None:
        self.app.title = "test picker"
        panel = self.query_one("#panel")
        panel.border_title = "test picker"
        # Legend mirrors the row colours (selection is shown by recolouring the
        # row, not a glyph). Rich markup colour tags, so no escape needed here.
        panel.border_subtitle = (
            f"[{_INK_DIM}]none[/]   [{_THEME.accent}]partial[/]   "
            f"[bold {_THEME.primary}]all[/]"
        )
        self.query_one("#kw-input", Input).border_title = escape(
            f"{_SEARCH_ICON}  search"
        )
        # The Input is first focusable in the DOM, so steal focus back to the
        # tree on mount to keep the single-key toggles live until the user opts
        # into the field.
        self.query_one(PickerTree).focus()
        self._refresh_status()
        self._refresh_sel()

    # --- tree construction -------------------------------------------------
    def _build(self, widget: TreeNode, tnode: TNode) -> None:
        for child in tnode.children:
            if child.is_leaf:
                leaf = widget.add_leaf(child.label)
                self._base_label[leaf] = child.label
                self._kind[leaf] = child.kind
                if child.node_id:
                    self._leaf_id[leaf] = child.node_id
            else:
                branch = widget.add(child.label, expand=True)
                self._base_label[branch] = child.label
                self._kind[branch] = child.kind
                self._build(branch, child)

    # --- selection helpers -------------------------------------------------
    def _leaves_under(self, node: TreeNode) -> set[str]:
        if node in self._leaf_id:
            return {self._leaf_id[node]}
        out: set[str] = set()
        for child in node.children:
            out |= self._leaves_under(child)
        return out

    def _all_nodes(self, node: TreeNode) -> list[TreeNode]:
        nodes = [node]
        for child in node.children:
            nodes.extend(self._all_nodes(child))
        return nodes

    def _refresh_labels(self, tree: PickerTree) -> None:
        # Point the tree's selection map at a fresh dict and fill it as we go,
        # so render_label always reads a level for every node it draws.
        state: dict[TreeNode, str] = {}
        tree.sel_state = state
        for node in self._all_nodes(tree.root):
            base = self._base_label.get(node, str(node.label))
            ids = self._leaves_under(node)
            sel = ids & self.selected
            if ids and sel == ids:
                level, style = "full", f"bold {_THEME.primary}"  # whole row
            elif sel:
                level, style = "partial", _THEME.accent          # some leaves
            else:
                level, style = "none", ""                        # nothing
            state[node] = level
            # The disclosure chevron, selected-row dot, and background wash are
            # added by PickerTree.render_label; the label is just the name,
            # recoloured fzf-style to show selection.
            node.set_label(Text(base, style=style))

    # --- toolbar state -----------------------------------------------------
    def _refresh_status(self) -> None:
        """Re-apply each chip's ``on`` class from the current option booleans."""
        state = {
            "toggle_cov": self.cov,
            "toggle_x": self.exitfirst,
            "toggle_lf": self.last_failed,
            "toggle_ff": self.failed_first,
            "toggle_v": self.verbose,
            "toggle_s": self.no_capture,
            "toggle_o": self.show_output,
        }
        for chip in self.query(FlagChip):
            chip.set_class(state.get(chip.action_name, False), "on")

    def _refresh_sel(self) -> None:
        """Update the right-docked selection readout (plain status, not a pill)."""
        n = len(self.selected)
        sel = self.query_one("#sel", Static)
        glyph = _SEL_FULL if n else _SEL_EMPTY
        sel.update(Text(f"{glyph} {n} selected" if n else f"{glyph} none selected"))
        sel.set_class(bool(n), "active")

    def options(self) -> RunOptions:
        return RunOptions(
            cov=self.cov,
            exitfirst=self.exitfirst,
            last_failed=self.last_failed,
            failed_first=self.failed_first,
            verbose=self.verbose,
            no_capture=self.no_capture,
            show_output=self.show_output,
        )

    # --- selection actions -------------------------------------------------
    def action_toggle_select(self) -> None:
        tree = self.query_one(PickerTree)
        node = tree.cursor_node
        if node is None:
            return
        ids = self._leaves_under(node)
        if ids and ids <= self.selected:
            self.selected -= ids
        else:
            self.selected |= ids
        self._refresh_labels(tree)
        self._refresh_sel()

    def action_expand_node(self) -> None:
        tree = self.query_one(PickerTree)
        node = tree.cursor_node
        if node is None or not node.allow_expand:
            return
        if not node.is_expanded:
            node.expand()
        elif node.children:
            # Already expanded → step into the first child (like pressing down).
            tree.move_cursor(node.children[0])

    def action_collapse_node(self) -> None:
        tree = self.query_one(PickerTree)
        node = tree.cursor_node
        if node is None:
            return
        # On an expanded directory, collapse the directory itself.
        if (
            node is not tree.root
            and self._kind.get(node) == "dir"
            and node.allow_expand
            and node.is_expanded
        ):
            node.collapse()
            return
        # Anywhere else (file, function, case, or a collapsed dir): collapse the
        # section that contains this node and move the cursor onto it.
        parent = node.parent
        if parent is None:
            return
        if parent is not tree.root and parent.allow_expand and parent.is_expanded:
            parent.collapse()
        tree.move_cursor(parent)

    def action_toggle_all(self) -> None:
        tree = self.query_one(PickerTree)
        everything = self._leaves_under(tree.root)
        self.selected = set() if self.selected >= everything else set(everything)
        self._refresh_labels(tree)
        self._refresh_sel()

    # --- run-option actions ------------------------------------------------
    def action_toggle_cov(self) -> None:
        self.cov = not self.cov
        self._refresh_status()

    def action_toggle_x(self) -> None:
        self.exitfirst = not self.exitfirst
        self._refresh_status()

    def action_toggle_lf(self) -> None:
        self.last_failed = not self.last_failed
        if self.last_failed:
            self.failed_first = False  # --lf and --ff are mutually exclusive
        self._refresh_status()

    def action_toggle_ff(self) -> None:
        self.failed_first = not self.failed_first
        if self.failed_first:
            self.last_failed = False
        self._refresh_status()

    def action_toggle_v(self) -> None:
        self.verbose = not self.verbose
        self._refresh_status()

    def action_toggle_s(self) -> None:
        self.no_capture = not self.no_capture
        self._refresh_status()

    def action_toggle_o(self) -> None:
        self.show_output = not self.show_output
        self._refresh_status()

    def action_search(self) -> None:
        """Focus the inline search bar (the `k` key and click target)."""
        self.query_one("#kw-input", Input).focus()

    def action_toggle_help(self) -> None:
        """Expand/collapse the floating bottom-right help badge."""
        badge = self.query_one(HelpBadge)
        badge.expanded = not badge.expanded

    # --- live tree filtering ----------------------------------------------
    def _apply_filter(self, query: str) -> None:
        """Rebuild the tree to only the nodes matching ``query``.

        Selection is keyed by node ID (not by widget), so it survives the
        teardown untouched and re-renders correctly on the pruned tree. Note
        that ``Tree.clear`` swaps in a fresh root node, so the per-node maps are
        rebuilt against the new root here.
        """
        if not self.is_mounted:
            return
        tree = self.query_one(PickerTree)
        self._filter_active = bool(query.strip())
        pruned = _filter_tree(self._root, query)
        tree.clear()
        self._leaf_id.clear()
        self._base_label.clear()
        self._kind.clear()
        self._base_label[tree.root] = self._root.label
        self._kind[tree.root] = self._root.kind
        self._build(tree.root, pruned)
        tree.root.expand()
        self._refresh_labels(tree)
        self._refresh_sel()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Filter the tree live on every keystroke in the search bar."""
        self._apply_filter(event.value)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Enter in the search bar keeps the filter and hands focus to the tree."""
        self.query_one(PickerTree).focus()

    # --- focus-aware key gating -------------------------------------------
    def _input_focused(self) -> bool:
        return isinstance(self.focused, Input)

    def check_action(self, action: str, parameters: tuple[object, ...]) -> bool | None:
        # Silence the priority tree bindings while the search field is focused so
        # the keystrokes reach the Input instead (see _INPUT_BLOCKED).
        if action in self._INPUT_BLOCKED and self._input_focused():
            return False
        return True

    # --- finish ------------------------------------------------------------
    def action_run(self) -> None:
        tree = self.query_one(PickerTree)
        chosen = set(self.selected)
        if not chosen:
            # Nothing explicitly selected: with an active filter, run every
            # visible match; otherwise fall back to the node under the cursor.
            if self._filter_active:
                chosen = self._leaves_under(tree.root)
            elif tree.cursor_node is not None:
                chosen = self._leaves_under(tree.cursor_node)
        self.app.exit((sorted(chosen), self.options()))

    def action_cancel(self) -> None:
        self.app.exit(None)

    def action_blur_or_cancel(self) -> None:
        # Escape blurs the search field back to the tree; on the tree it quits.
        if self._input_focused():
            self.query_one(PickerTree).focus()
        else:
            self.app.exit(None)


class TestPicker(App):
    def __init__(self, root: TNode, opts: RunOptions) -> None:
        super().__init__()
        self._root = root
        self._opts = opts

    def on_mount(self) -> None:
        self.register_theme(_THEME)
        self.theme = "picker"
        self.push_screen(PickerScreen(self._root, self._opts))

    def action_help_quit(self) -> None:
        # Override Textual's reflexive-ctrl+C hint: ctrl+q is unreliable inside
        # VS Code's integrated terminal, but escape always quits here.
        self.notify("Press [b]escape[/b] to quit the app", title="Do you want to quit?")


def run_picker(
    node_ids: list[str], opts: RunOptions
) -> tuple[list[str], RunOptions] | None:
    """Launch the picker. Returns ``(node_ids, options)`` or None if cancelled."""
    root = build_tree(node_ids)
    app = TestPicker(root, opts)
    return app.run()
