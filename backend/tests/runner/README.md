# Test runner

An interactive test runner: discover tests via pytest's own collector, cherry-pick
them in a Textual tree, and run them while a live Rich dashboard streams pass/fail.

```
python -m tests.runner            # discover → picker → run
python -m tests.runner -k ingest  # skip the picker, run a -k selection
python -m tests.runner tests/api  # run specific paths
```

## Two-venv design

The runner is split across two interpreters so it can be dropped into any repo
without polluting that repo's test environment:

| Process | venv | Imports | Needs |
| --- | --- | --- | --- |
| Runner (parent) | runner venv | `typer`, `rich`, `textual` | the UI libs only — **never** pytest |
| Worker (subprocess) | test venv | `pytest`, `coverage` | pytest, pytest-asyncio, coverage + the project's own deps |

Discovery and execution both run in the **test venv** via subprocess. The worker
([`_worker.py`](./_worker.py)) registers a thin pytest plugin that frames every
collection/run event (and, in `-s` mode, each line of streamed output) as JSON
onto a pipe. The parent ([`run.py`](./run.py)) reads those events and owns all
Rich rendering. See [`events.py`](./events.py) for the wire protocol.

```
parent (rich)  <—— JSON events over a pipe FD ——  worker (pytest, test venv)
```

## Setup

The easiest path is the one-command launcher, which provisions both venvs and
runs the picker:

```
bash backend/tests/run.sh            # discover -> picker -> run
bash backend/tests/run.sh -k ingest  # any flags/paths forward to the runner
```

To wire it up by hand instead:

1. Runner venv (the UI) — install the libs declared in
   [`pyproject.toml`](./pyproject.toml). The package is imported from the source
   tree (parent runs with `cwd=backend`), so only its deps need installing:

   ```
   python -m venv backend/tests/.runner-venv
   backend/tests/.runner-venv/bin/pip install typer rich textual
   ```

2. Test venv (where tests actually run) — your project's existing venv with
   `pytest`, `pytest-asyncio`, and `coverage` installed (`backend/.venv` via
   `backend/requirements-dev.txt`).

3. Point the runner at the test venv in [`config.json`](./config.json).
   `venv_python` is resolved relative to `repo_root` (which is `backend/`), so
   the value is `.venv/bin/python`, not `backend/.venv/bin/python`.

## config.json

All path/venv coupling lives here so no code edits are needed per repo:

| key | meaning | default |
| --- | --- | --- |
| `repo_root` | cwd for pytest; resolved relative to this folder | `../..` (repo root) |
| `test_paths` | default search roots when no paths are given | `["tests/unit", "tests/api"]` |
| `venv_python` | interpreter the **tests** run in; relative to `repo_root` | the runner's own interpreter |
| `coverage_source` | packages measured under `--cov` and the report filter | `["backend"]` |
| `icons` | picker glyph tier: `nerd` / `emoji` / `unicode` / `ascii` | `unicode` |

If `venv_python` is unset or missing on disk, the runner falls back to the
current interpreter (single-venv mode), reproducing the original behavior.

## Picker icons

`icons` picks the glyph set for the picker's checkboxes, expand chevrons, and
search badge. It's a **ceiling**: each icon resolves to the fanciest variant at
or below the chosen tier, so a tier without a given glyph degrades per-icon
rather than breaking. Unknown values fall back to `unicode`.

- `unicode` (default) — plain shapes (`○ ◐ ●`, `▶ ▼`, `⌕`); works in any terminal.
- `emoji` — 📁/📂 folders and 🔍 search; renders natively on macOS, no setup.
- `ascii` — `[ ] [~] [x]`, `> v`, `/`; safe on the dumbest terminals.
- `nerd` — Material Design checkboxes + Font Awesome folder/search glyphs.

**`nerd` needs a patched [Nerd Font](https://www.nerdfonts.com/).** Those glyphs
live in the Unicode Private Use Area, so without a Nerd Font your terminal shows
blanks/boxes instead of icons. Install one, e.g.:

```
brew install --cask font-hack-nerd-font   # or font-jetbrains-mono-nerd-font, font-meslo-lg-nerd-font, ...
```

Then set your terminal's font to it (in Cursor/VS Code, that's the
`terminal.integrated.fontFamily` setting, e.g. `"Hack Nerd Font"`) and reload
the terminal.
