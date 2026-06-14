"""Interactive Textual tree picker.

Renders the discovered test tree with checkboxes and a row of run-option
toggles (coverage, stop-on-first-fail, last-failed, failed-first, verbose, and a
``-k`` keyword expression). Returns ``(node_ids, RunOptions)`` for the selection
or ``None`` if cancelled. Selecting a branch selects all descendant leaves.
Every row always shows a box: empty when unselected, checked when selected, and
a half-filled box when only some descendants are selected.

The tree keybindings live on a ``Screen`` (not the ``App``) so they go quiet
while the keyword modal is open and you can freely type expressions like
``ingest and not batch`` without the single-key toggles firing.
"""

from __future__ import annotations

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import Footer, Header, Input, Label, Static, Tree
from textual.widgets.tree import TreeNode

from tests.runner.run import RunOptions
from tests.runner.tree import TNode, build_tree

# Always-visible ballot-box glyphs (matched empty/checked pair) + a partial box.
_BOX_EMPTY = "\u2610"     # ☐
_BOX_FULL = "\u2611"      # ☑
_BOX_PARTIAL = "\u25a3"   # ▣


class KeywordScreen(ModalScreen[str | None]):
    """Modal text prompt for the pytest ``-k`` expression."""

    CSS = """
    KeywordScreen { align: center middle; }
    #kw-box {
        width: 64;
        height: auto;
        padding: 1 2;
        background: $panel;
        border: round $accent;
    }
    #kw-box Label { margin-bottom: 1; }
    """

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, current: str) -> None:
        super().__init__()
        self._current = current

    def compose(self) -> ComposeResult:
        with Vertical(id="kw-box"):
            yield Label("pytest -k expression  (enter to apply, blank to clear)")
            yield Input(
                value=self._current,
                placeholder="e.g. ingest and not batch",
                id="kw-input",
            )

    def on_mount(self) -> None:
        self.query_one(Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value.strip())

    def action_cancel(self) -> None:
        self.dismiss(None)


class PickerScreen(Screen):
    CSS = """
    Tree { padding: 0 1; }
    #status { padding: 0 1; }
    """

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
        Binding("k", "keyword", "keyword"),
        Binding("q", "cancel", "Quit", priority=True),
        Binding("escape", "cancel", "Quit", priority=True),
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
        self.keyword = opts.keyword

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield Static(id="status")
        tree: Tree = Tree(self._root.label, id="tree")
        tree.root.expand()
        self._base_label[tree.root] = self._root.label
        self._kind[tree.root] = self._root.kind
        self._build(tree.root, self._root)
        self._refresh_labels(tree)
        yield tree
        yield Footer()

    def on_mount(self) -> None:
        self.app.title = "test picker"
        self.app.sub_title = (
            f"{_BOX_EMPTY} empty   {_BOX_FULL} selected   {_BOX_PARTIAL} partial"
        )
        self._refresh_status()

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

    def _refresh_labels(self, tree: Tree) -> None:
        for node in self._all_nodes(tree.root):
            base = self._base_label.get(node, str(node.label))
            ids = self._leaves_under(node)
            sel = ids & self.selected
            if ids and sel == ids:
                glyph, style = _BOX_FULL, "bold green"
            elif sel:
                glyph, style = _BOX_PARTIAL, "bold yellow"
            else:
                glyph, style = _BOX_EMPTY, "grey62"
            label = Text.assemble((f"{glyph} ", style), (base, ""))
            node.set_label(label)

    # --- run-option status line -------------------------------------------
    def _refresh_status(self) -> None:
        def mark(on: bool) -> str:
            return "[bold green]on[/]" if on else "[dim]off[/]"

        kw = self.keyword or "[dim]—[/]"
        status = "  ".join(
            [
                f"[bold]\\[c][/] cov {mark(self.cov)}",
                f"[bold]\\[x][/] stop {mark(self.exitfirst)}",
                f"[bold]\\[l][/] --lf {mark(self.last_failed)}",
                f"[bold]\\[f][/] --ff {mark(self.failed_first)}",
                f"[bold]\\[v][/] -v {mark(self.verbose)}",
                f"[bold]\\[s][/] -s {mark(self.no_capture)}",
                f"[bold]\\[o][/] out {mark(self.show_output)}",
                f"[bold]\\[k][/] -k {kw}",
            ]
        )
        self.query_one("#status", Static).update(status)

    def options(self) -> RunOptions:
        return RunOptions(
            cov=self.cov,
            exitfirst=self.exitfirst,
            last_failed=self.last_failed,
            failed_first=self.failed_first,
            verbose=self.verbose,
            no_capture=self.no_capture,
            show_output=self.show_output,
            keyword=self.keyword,
        )

    # --- selection actions -------------------------------------------------
    def action_toggle_select(self) -> None:
        tree = self.query_one(Tree)
        node = tree.cursor_node
        if node is None:
            return
        ids = self._leaves_under(node)
        if ids and ids <= self.selected:
            self.selected -= ids
        else:
            self.selected |= ids
        self._refresh_labels(tree)

    def action_expand_node(self) -> None:
        tree = self.query_one(Tree)
        node = tree.cursor_node
        if node is None or not node.allow_expand:
            return
        if not node.is_expanded:
            node.expand()
        elif node.children:
            # Already expanded → step into the first child (like pressing down).
            tree.move_cursor(node.children[0])

    def action_collapse_node(self) -> None:
        tree = self.query_one(Tree)
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
        tree = self.query_one(Tree)
        everything = self._leaves_under(tree.root)
        self.selected = set() if self.selected >= everything else set(everything)
        self._refresh_labels(tree)

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

    def action_keyword(self) -> None:
        def apply(value: str | None) -> None:
            if value is not None:  # None = cancelled, leave keyword untouched
                self.keyword = value or None
                self._refresh_status()

        self.app.push_screen(KeywordScreen(self.keyword or ""), apply)

    # --- finish ------------------------------------------------------------
    def action_run(self) -> None:
        chosen = set(self.selected)
        if not chosen:
            node = self.query_one(Tree).cursor_node
            if node is not None:
                chosen = self._leaves_under(node)
        self.app.exit((sorted(chosen), self.options()))

    def action_cancel(self) -> None:
        self.app.exit(None)


class TestPicker(App):
    def __init__(self, root: TNode, opts: RunOptions) -> None:
        super().__init__()
        self._root = root
        self._opts = opts

    def on_mount(self) -> None:
        self.push_screen(PickerScreen(self._root, self._opts))


def run_picker(
    node_ids: list[str], opts: RunOptions
) -> tuple[list[str], RunOptions] | None:
    """Launch the picker. Returns ``(node_ids, options)`` or None if cancelled."""
    root = build_tree(node_ids)
    app = TestPicker(root, opts)
    return app.run()
