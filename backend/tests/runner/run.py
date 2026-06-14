"""Subprocess pytest execution with a live Rich dashboard.

pytest runs in a separate process (the configured *test* venv) via
``tests.runner._worker``. That worker streams framed events over a pipe; this
module consumes them, mutates a :class:`Dashboard`, and renders a live Rich
panel plus a final summary and (optionally) a coverage table. Keeping execution
out-of-process is what lets the runner's own venv stay free of pytest and the
project's test dependencies.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass

from rich import box
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.progress_bar import ProgressBar
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from tests.runner import events
from tests.runner.config import load_config

_CONFIG = load_config()

# Cap per-test captured output so one chatty test can't flood the scrollback.
_MAX_OUTPUT_LINES = 40

_OUTCOME_GLYPH: dict[str, tuple[str, str]] = {
    "passed": ("\u2713", "green"),       # ✓
    "failed": ("\u2717", "bold red"),    # ✗
    "skipped": ("\u21b7", "yellow"),     # ↷
    "error": ("\u2717", "bold magenta"),  # ✗ (setup/teardown)
}


def _short(nodeid: str, width: int = 80) -> str:
    """Keep the spinner's current-test label on a single line."""
    return nodeid if len(nodeid) <= width else "…" + nodeid[-(width - 1):]


@dataclass
class RunOptions:
    """Execution options shared between the CLI, the picker, and run_tests."""

    cov: bool = False          # measure backend/ coverage
    exitfirst: bool = False    # -x  : stop after the first failure
    last_failed: bool = False  # --lf: run only last-failed tests
    failed_first: bool = False  # --ff: run last-failed first, then the rest
    verbose: bool = False      # -v  : richer failure output (untruncated asserts)
    no_capture: bool = False   # -s  : stream test stdout / print() output live
    show_output: bool = False  # -O  : show captured output for passing tests too


@dataclass
class RunSummary:
    """The post-run picture the action prompt needs to offer its reruns.

    ``all_ids`` is every collected node ID (rerun-all), ``passed_ids`` the ones
    that passed, ``failed_ids`` the ones that failed/errored. Skipped tests are
    deliberately in neither pass nor fail bucket.
    """

    all_ids: list[str]
    passed_ids: list[str]
    failed_ids: list[str]


class Dashboard:
    """Event consumer + Rich renderer (runs in the parent / runner venv).

    Equivalent to the old in-process collector, but instead of pytest hooks it
    is driven by :meth:`handle_event` over events streamed from the worker. All
    counters, per-file tallies, and the two live layouts are unchanged:

    * ``-s`` ON: output streams live, so each test gets a header rule + a
      persistent ``✓/✗ nodeid duration`` scrollback line bracketing its prints.
    * ``-s`` OFF: a per-file table with live ``passed/failed/total`` counters is
      pinned at the bottom; captured output for failures (or all tests under
      ``-O``) still prints above it.

    The dashboard renders itself (``__rich__``) so Live's auto-refresh animates
    the spinner and ticks the elapsed clock without us pushing snapshots.
    """

    def __init__(self, opts: RunOptions) -> None:
        self.opts = opts
        self.total = 0
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.errors = 0
        self.current = ""
        self.failures: list[tuple[str, str]] = []
        # Every collected node ID (in collection order) + the final outcome per
        # node, so the post-run prompt can offer rerun-all / passed / failed.
        self._collected: list[str] = []
        self._outcome: dict[str, str] = {}
        self.live: Live | None = None
        self._start = time.time()
        self._current_start = self._start
        # Per-test accumulator across setup/call/teardown phases, keyed by nodeid.
        self._pending: dict[str, dict] = {}
        self._spinner = Spinner("dots", style="cyan")
        # Per-file tallies for the -s-off view (files in collection order).
        self._file_order: list[str] = []
        self._file_total: dict[str, int] = defaultdict(int)
        self._file_pass: dict[str, int] = defaultdict(int)
        self._file_fail: dict[str, int] = defaultdict(int)
        self._file_skip: dict[str, int] = defaultdict(int)
        self._current_file = ""
        # -s streaming: track the open file bracket so we can rail + close it.
        self._streamed_file: str | None = None
        self._file_open = False

    @staticmethod
    def _file_of(nodeid: str) -> str:
        return nodeid.split("::", 1)[0]

    # --- event dispatch ----------------------------------------------------
    def handle_event(self, evt: dict) -> None:
        etype = evt.get("type")
        if etype == events.COLLECTION:
            self._on_collection(evt["items"])
        elif etype == events.LOGSTART:
            self._on_logstart(evt["nodeid"])
        elif etype == events.LOGREPORT:
            self._on_logreport(evt)
        elif etype == events.LOGFINISH:
            self._on_logfinish(evt["nodeid"])
        elif etype == events.OUTPUT:
            self._emit_stream_line(evt["line"])

    def _on_collection(self, items: list[str]) -> None:
        self.total = len(items)
        self._collected = list(items)
        for nodeid in items:
            f = self._file_of(nodeid)
            if f not in self._file_total:
                self._file_order.append(f)
            self._file_total[f] += 1
        self._refresh()

    def _on_logstart(self, nodeid: str) -> None:
        self.current = nodeid
        self._current_file = self._file_of(nodeid)
        self._current_start = time.time()
        # In -s mode, output streams live; print a file header box (once per
        # file) and a per-test header box so the prints that follow are
        # attributable. The streamed output itself is left unboxed.
        if self.opts.no_capture and self.live is not None:
            self._emit_stream_headers(nodeid)
        self._refresh()

    def _on_logreport(self, evt: dict) -> None:
        nodeid = evt["nodeid"]
        when = evt["when"]
        entry = self._pending.setdefault(
            nodeid, {"outcome": "passed", "duration": 0.0, "out": ""}
        )
        entry["duration"] += evt.get("duration", 0.0) or 0.0
        # Take captured output from the authoritative phase only: the call, or
        # setup when setup fails/skips (no call then). pytest's teardown report
        # re-includes the call's capstdout, so summing every phase would
        # duplicate the test's output.
        if when == "call" or (when == "setup" and (evt["failed"] or evt["skipped"])):
            out = (evt.get("capstdout") or "") + (evt.get("capstderr") or "")
            if out:
                entry["out"] = out

        longrepr = evt.get("longreprtext") or ""
        if when == "setup":
            if evt["skipped"]:
                entry["outcome"] = "skipped"
                self.skipped += 1
            elif evt["failed"]:
                entry["outcome"] = "error"
                self.errors += 1
                self.failures.append((nodeid + " (setup)", longrepr))
        elif when == "call":
            if evt["passed"]:
                self.passed += 1
            elif evt["failed"]:
                entry["outcome"] = "failed"
                self.failed += 1
                self.failures.append((nodeid, longrepr))
            elif evt["skipped"]:
                entry["outcome"] = "skipped"
                self.skipped += 1
        elif when == "teardown" and evt["failed"]:
            if entry["outcome"] == "passed":
                entry["outcome"] = "error"
            self.errors += 1
            self.failures.append((nodeid + " (teardown)", longrepr))
        self._refresh()

    def _on_logfinish(self, nodeid: str) -> None:
        entry = self._pending.pop(nodeid, None)
        self.current = ""
        if entry is None:
            self._refresh()
            return

        # Update per-file tallies for the -s-off table.
        f = self._file_of(nodeid)
        outcome = entry["outcome"]
        self._outcome[nodeid] = outcome
        if outcome == "passed":
            self._file_pass[f] += 1
        elif outcome in ("failed", "error"):
            self._file_fail[f] += 1
        elif outcome == "skipped":
            self._file_skip[f] += 1

        if self.live is not None:
            if self.opts.no_capture:
                # Streamed mode: persistent per-test line bracketing the output.
                self._emit_test_line(nodeid, entry)
            else:
                # File-counter mode: no per-test line, but still surface
                # captured output for failures (or all tests under -O).
                self._emit_output_panel(nodeid, entry)
        self._refresh()

    # --- streaming (-s) nested brackets -----------------------------------
    # Two levels: a blue outer bracket per .py file wraps the grey inner
    # bracket of each test, so tests chunk visually by their parent file.
    #
    #     ╔═ test_persist.py ═╗   (file header box)
    #     ┃ ╭ test_one          (┃ = blue file rail; ╭ opens the test)
    #     ┃ │ ...streamed output (railed + gutter-wrapped)
    #     ┃ ╰ ✓ 11ms            (closes the test)
    #     ┃
    #     ┗━━━                   (blue foot closes the file)
    _OUTER = "\u2503 "   # "┃ "
    _FOOT = "\u2517" + "\u2501" * 3  # "┗━━━"
    _OPEN = "\u256d "    # "╭ "
    _RAIL = "\u2502 "    # "│ "
    _CLOSE = "\u2570 "   # "╰ "
    _OUTER_STYLE = "blue"

    def _outer(self) -> Text:
        return Text(self._OUTER, style=self._OUTER_STYLE)

    def _emit_stream_headers(self, nodeid: str) -> None:
        f = self._file_of(nodeid)
        if f != self._streamed_file:
            self._close_file_bracket()  # close the previous file's blue bracket
            self._streamed_file = f
            self.live.console.print(self._file_header(f))
            self._file_open = True
        name = nodeid.split("::", 1)[1] if "::" in nodeid else nodeid
        self.live.console.print(
            self._outer() + Text.assemble((self._OPEN, "grey50"), (name, "bold"))
        )

    def _close_file_bracket(self) -> None:
        if self.live is not None and self._file_open:
            self.live.console.print(Text(self._FOOT, style=self._OUTER_STYLE))
            self.live.console.print()
        self._file_open = False

    @staticmethod
    def _file_header(f: str):
        return Panel(
            Text(f, style="bold blue"),
            box=box.DOUBLE,
            border_style="blue",
            expand=False,
            padding=(0, 1),
        )

    def _emit_stream_line(self, line: str) -> None:
        """Forward one line of test output, railed inside both brackets."""
        if self.live is None:
            return
        if line == "":
            self.live.console.print(self._outer() + Text("\u2502", style="grey50"))
            return
        inner = Text(self._RAIL, style="grey50")
        text = Text.from_ansi(line)
        prefix_w = len(self._OUTER) + len(self._RAIL)
        width = max(self.live.console.size.width - prefix_w, 1)
        for seg in text.wrap(self.live.console, width):
            self.live.console.print(self._outer() + inner + seg)

    # --- scrollback emitters ----------------------------------------------
    def _emit_test_line(self, nodeid: str, entry: dict) -> None:
        outcome = entry["outcome"]
        glyph, style = _OUTCOME_GLYPH.get(outcome, ("\u2022", "white"))
        dur = entry["duration"]
        timing = f"{dur * 1000:.0f}ms" if dur < 1 else f"{dur:.2f}s"
        # Close the test bracket with the result, then a rail-only spacer line.
        self.live.console.print(
            self._outer()
            + Text.assemble((self._CLOSE, style), (f"{glyph} ", style), (timing, "dim"))
        )
        self.live.console.print(self._outer())

    def _emit_output_panel(self, nodeid: str, entry: dict) -> None:
        outcome = entry["outcome"]
        _, style = _OUTCOME_GLYPH.get(outcome, ("\u2022", "white"))
        out = entry["out"].rstrip()
        show = self.opts.show_output or outcome in ("failed", "error")
        if out and show:
            self.live.console.print(self._output_panel(nodeid, out, style))

    def _output_panel(self, nodeid: str, out: str, style: str) -> Panel:
        lines = out.splitlines()
        hidden = len(lines) - _MAX_OUTPUT_LINES
        if hidden > 0:
            body = Text("\n".join(lines[-_MAX_OUTPUT_LINES:]))
            body.append(f"\n… {hidden} earlier line(s) hidden", style="dim italic")
        else:
            body = Text(out)
        return Panel(
            body,
            title=f"output · {nodeid}",
            title_align="left",
            border_style="grey42",
            padding=(0, 1),
        )

    # --- rendering ---------------------------------------------------------
    @property
    def done(self) -> int:
        return self.passed + self.failed + self.skipped + self.errors

    def _refresh(self) -> None:
        if self.live is not None:
            try:
                self.live.refresh()
            except Exception:
                pass

    def __rich__(self):
        return self.render_progress()

    def render_progress(self):
        # -s off → per-file counter table; -s on → overall bar + streaming spinner.
        if self.opts.no_capture:
            return self._render_streaming()
        return self._render_by_file()

    def _current_line(self):
        """The animated 'currently running' spinner line (shared by both views)."""
        if self.current:
            elapsed = time.time() - self._current_start
            self._spinner.update(
                text=Text.assemble(
                    (_short(self.current), "cyan"), (f"  {elapsed:0.1f}s", "cyan dim")
                )
            )
            return self._spinner
        if self.total and self.done >= self.total:
            return Text("finished", style="green dim")
        return Text("collecting…", style="cyan dim")

    def _render_streaming(self):
        bar = ProgressBar(total=max(self.total, 1), completed=self.done, width=46)
        counts = Text.assemble(
            ("  passed ", "dim"), (f"{self.passed}", "bold green"),
            ("   failed ", "dim"), (f"{self.failed}", "bold red"),
            ("   skipped ", "dim"), (f"{self.skipped}", "bold yellow"),
            ("   errors ", "dim"), (f"{self.errors}", "bold magenta"),
        )
        progress_line = Text.assemble(
            (f"{self.done}", "bold"), (f"/{self.total}  ", "dim"),
        )
        return Panel(
            Group(Group(progress_line, bar), counts, self._current_line()),
            title="[bold]running tests[/bold]",
            border_style="cyan",
        )

    def _render_by_file(self):
        if not self._file_order:
            return Panel(
                Text("collecting…", style="cyan dim"),
                title="[bold]running tests[/bold]",
                border_style="cyan",
            )
        table = Table(show_header=False, box=None, pad_edge=False, expand=False)
        table.add_column(width=1)                 # running marker
        table.add_column(no_wrap=True)            # file
        table.add_column(justify="right")         # passed
        table.add_column(justify="right")         # failed
        table.add_column(justify="right")         # done/total
        table.add_column(width=18)                # progress bar
        for f in self._file_order:
            total = self._file_total.get(f, 0)
            passed = self._file_pass.get(f, 0)
            failed = self._file_fail.get(f, 0)
            skipped = self._file_skip.get(f, 0)
            done = passed + failed + skipped
            complete = total > 0 and done >= total
            running = f == self._current_file and not complete and bool(self.current)

            if running:
                marker = Text("\u25b6", style="cyan")          # ▶
            elif complete:
                marker = Text("\u2713" if failed == 0 else "\u2717",
                              style="green" if failed == 0 else "bold red")
            else:
                marker = Text(" ")

            name_style = "bold red" if failed else ("green" if complete else
                                                    "cyan" if running else "")
            bar_style = "red" if failed else "green"
            table.add_row(
                marker,
                Text(f, style=name_style),
                Text(f"{passed}\u2713", style="green" if passed else "dim"),
                Text(f"{failed}\u2717", style="bold red" if failed else "dim"),
                Text(f"{done}/{total}", style="dim"),
                ProgressBar(
                    total=max(total, 1), completed=done, width=18,
                    complete_style=bar_style, finished_style=bar_style,
                ),
            )
        return Panel(
            Group(table, self._current_line()),
            title="[bold]running tests[/bold]",
            border_style="cyan",
        )

    def render_summary(self, console: Console) -> None:
        elapsed = time.time() - self._start
        ok = self.failed == 0 and self.errors == 0
        table = Table(show_header=False, box=None, pad_edge=False)
        table.add_row(Text("passed", style="green"), Text(str(self.passed), style="bold green"))
        if self.failed:
            table.add_row(Text("failed", style="red"), Text(str(self.failed), style="bold red"))
        if self.skipped:
            table.add_row(Text("skipped", style="yellow"), Text(str(self.skipped), style="bold yellow"))
        if self.errors:
            table.add_row(Text("errors", style="magenta"), Text(str(self.errors), style="bold magenta"))
        table.add_row(Text("time", style="dim"), Text(f"{elapsed:.2f}s", style="dim"))

        verdict = "[bold green]PASSED[/]" if ok else "[bold red]FAILED[/]"
        console.print(
            Panel(table, title=verdict, border_style="green" if ok else "red")
        )

        for nodeid, longrepr in self.failures:
            console.print(
                Panel(
                    Text(longrepr or "(no traceback captured)"),
                    title=f"[red]{nodeid}[/]",
                    border_style="red",
                )
            )

    def all_ids(self) -> list[str]:
        """Every collected node ID, in collection order (rerun-all target)."""
        return list(self._collected)

    def passed_ids(self) -> list[str]:
        """Collected node IDs whose final outcome was a pass (skips excluded)."""
        return [n for n in self._collected if self._outcome.get(n) == "passed"]

    def failed_ids(self) -> list[str]:
        """The deduped, real pytest node IDs of everything that failed.

        Strips the " (setup)" / " (teardown)" phase suffixes we tack on in
        ``self.failures`` so each entry is a target you can hand straight back
        to pytest.
        """
        seen: set[str] = set()
        out: list[str] = []
        for nodeid, _ in self.failures:
            clean = nodeid.split(" (", 1)[0]
            if clean not in seen:
                seen.add(clean)
                out.append(clean)
        return out


def render_coverage(console: Console, rows: list, total: float) -> None:
    """Render the coverage table from rows computed by the worker."""
    table = Table(title="coverage", title_style="bold", header_style="dim")
    table.add_column("file")
    table.add_column("stmts", justify="right")
    table.add_column("miss", justify="right")
    table.add_column("cover", justify="right")

    for rel, n, miss, pct in sorted(rows, key=lambda r: r[3]):
        colour = "green" if pct >= 90 else "yellow" if pct >= 70 else "red"
        table.add_row(rel, str(n), str(miss), Text(f"{pct:.0f}%", style=colour))

    console.print(table)
    if total is not None:
        tcolour = "green" if total >= 90 else "yellow" if total >= 70 else "red"
        console.print(Text.assemble(("TOTAL  ", "bold"), (f"{total:.0f}%", f"bold {tcolour}")))


def _build_pytest_args(node_ids: list[str], opts: RunOptions) -> list[str]:
    """Translate RunOptions into the pytest flags handed to the worker."""
    args: list[str] = []
    if opts.exitfirst:
        args.append("-x")
    if opts.last_failed:
        args.append("--lf")
    if opts.failed_first:
        args.append("--ff")
    if opts.verbose:
        # `-v` is owned by pytest's terminal plugin, which the worker disables
        # via `-p no:terminal`. The part of verbosity that still matters for our
        # custom dashboard is untruncated assertion diffs in the failure panels,
        # which this core ini option controls independently.
        args += ["-o", "verbosity_assertions=2"]
    if opts.no_capture:
        # Disable pytest's output capture so test stdout / print() reaches the
        # worker's gutter shim, which frames each line back to us as an event.
        args.append("-s")
    args += node_ids
    return args


def run_tests(node_ids: list[str], opts: RunOptions | None = None) -> tuple[int, RunSummary]:
    """Run the given node IDs in the test venv (subprocess).

    Returns ``(exit_code, summary)`` where ``summary`` carries the collected /
    passed / failed node IDs for the post-run action prompt.
    """
    if opts is None:
        opts = RunOptions()
    if not node_ids:
        node_ids = list(_CONFIG.test_paths)

    console = Console(file=sys.stdout)
    dashboard = Dashboard(opts)

    worker_opts = {
        "pytest_args": _build_pytest_args(node_ids, opts),
        "no_capture": opts.no_capture,
        "cov": opts.cov,
        "coverage_source": _CONFIG.coverage_source,
        "repo_root": str(_CONFIG.repo_root),
    }

    # The worker writes framed events to `w`; we read them from `r`. Its stderr
    # goes to a temp file (not a pipe) so a chatty/​crashing worker can never
    # deadlock against our event read.
    r, w = os.pipe()
    err_file = tempfile.TemporaryFile(mode="w+")
    proc = subprocess.Popen(
        [_CONFIG.venv_python, "-m", "tests.runner._worker", str(w), json.dumps(worker_opts)],
        cwd=str(_CONFIG.repo_root),
        pass_fds=(w,),
        stdout=subprocess.DEVNULL,
        stderr=err_file,
    )
    os.close(w)  # parent keeps only the read end

    exit_code: int | None = None
    saw_collection = False
    cov_rows: list | None = None
    cov_total: float | None = None
    cov_error: str | None = None

    with Live(
        dashboard,
        console=console,
        refresh_per_second=12,
        redirect_stdout=False,
        redirect_stderr=False,
    ) as live:
        dashboard.live = live
        with os.fdopen(r, "r", buffering=1) as stream:
            for line in stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = evt.get("type")
                if etype == events.COLLECTION:
                    saw_collection = True
                elif etype == events.COVERAGE:
                    cov_rows = evt.get("rows")
                    cov_total = evt.get("total")
                    cov_error = evt.get("error")
                    continue
                elif etype == events.DONE:
                    exit_code = int(evt.get("code", 1))
                    continue
                dashboard.handle_event(evt)
        if opts.no_capture:
            dashboard._close_file_bracket()  # close the last file bracket
        live.refresh()

    proc.wait()
    if exit_code is None:
        exit_code = proc.returncode

    dashboard.render_summary(console)
    if cov_error:
        console.print(f"[yellow]coverage unavailable: {cov_error}[/]")
    elif cov_rows is not None:
        render_coverage(console, cov_rows, cov_total)

    # If the worker died before collecting anything (e.g. an import error in a
    # test module, or a missing test venv), surface its stderr.
    if not saw_collection and exit_code != 0:
        err_file.seek(0)
        stderr_text = err_file.read().strip()
        if stderr_text:
            console.print(
                Panel(Text(stderr_text), title="[red]worker stderr[/]", border_style="red")
            )
    err_file.close()

    return int(exit_code), RunSummary(
        all_ids=dashboard.all_ids(),
        passed_ids=dashboard.passed_ids(),
        failed_ids=dashboard.failed_ids(),
    )
