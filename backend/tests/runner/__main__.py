"""Typer entrypoint:  python -m tests.runner

Default (no args): discover tests → interactive Textual picker → run selection.
With paths / -k / --no-pick: skip the picker and run directly.
"""

from __future__ import annotations

from typing import List, Optional

import typer
from rich.console import Console

from tests.runner.discovery import discover
from tests.runner.picker import run_picker
from tests.runner.run import RunOptions, run_tests

console = Console()


def main(
    paths: Optional[List[str]] = typer.Argument(
        None, help="pytest paths or node IDs to target (skips the picker)."
    ),
    keyword: Optional[str] = typer.Option(
        None, "-k", help="Only tests matching this keyword expression (skips the picker)."
    ),
    cov: bool = typer.Option(False, "--cov", help="Measure and report coverage of backend/."),
    exitfirst: bool = typer.Option(
        False, "-x", "--exitfirst", help="Stop after the first failure."
    ),
    last_failed: bool = typer.Option(
        False, "--lf", "--last-failed", help="Run only the tests that failed last time."
    ),
    failed_first: bool = typer.Option(
        False, "--ff", "--failed-first", help="Run last-failed tests first, then the rest."
    ),
    verbose: bool = typer.Option(
        False, "-v", "--verbose", help="Richer failure output (untruncated assertions)."
    ),
    no_capture: bool = typer.Option(
        False, "-s", "--no-capture", help="Show test stdout / print() output live (pytest -s)."
    ),
    show_output: bool = typer.Option(
        False, "-O", "--show-output", help="Show captured output for passing tests too (not just failures)."
    ),
    pick: bool = typer.Option(
        True, "--pick/--no-pick", help="Open the interactive picker (default on)."
    ),
) -> None:
    try:
        node_ids = discover(paths, keyword)
    except RuntimeError as exc:
        console.print(f"[red]discovery failed:[/]\n{exc}")
        raise typer.Exit(2)

    if not node_ids:
        console.print("[yellow]No tests found.[/]")
        raise typer.Exit(5)

    # CLI flags seed the picker's toggles and drive the non-interactive run.
    opts = RunOptions(
        cov=cov,
        exitfirst=exitfirst,
        last_failed=last_failed,
        failed_first=failed_first,
        verbose=verbose,
        no_capture=no_capture,
        show_output=show_output,
    )

    interactive = pick and not paths and not keyword
    if interactive:
        picked = run_picker(node_ids, opts)
        if picked is None:
            console.print("[dim]cancelled[/]")
            raise typer.Exit(0)
        node_ids, opts = picked
        if not node_ids:
            console.print("[yellow]Nothing selected.[/]")
            raise typer.Exit(0)

    code = run_tests(node_ids, opts)
    raise typer.Exit(code)


if __name__ == "__main__":
    typer.run(main)
