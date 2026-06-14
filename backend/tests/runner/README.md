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

1. Runner venv (the UI):

   ```
   python -m venv .runner-venv
   .runner-venv/bin/pip install -e tests/runner
   ```

2. Test venv (where tests actually run) — your project's existing venv with
   `pytest`, `pytest-asyncio`, and `coverage` installed.

3. Point the runner at the test venv in [`config.json`](./config.json).

## config.json

All path/venv coupling lives here so no code edits are needed per repo:

| key | meaning | default |
| --- | --- | --- |
| `repo_root` | cwd for pytest; resolved relative to this folder | `../..` (repo root) |
| `test_paths` | default search roots when no paths are given | `["tests/unit", "tests/api"]` |
| `venv_python` | interpreter the **tests** run in; relative to `repo_root` | the runner's own interpreter |
| `coverage_source` | packages measured under `--cov` and the report filter | `["backend"]` |

If `venv_python` is unset or missing on disk, the runner falls back to the
current interpreter (single-venv mode), reproducing the original behavior.
