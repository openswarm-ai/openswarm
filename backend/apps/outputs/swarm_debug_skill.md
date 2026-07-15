# swarm-debug — OpenSwarm's logger for App backends

`swarm_debug` (the `swarm-debug` package on PyPI) is OpenSwarm's opinionated
`print()` replacement for the App Builder's backend code. It prints colored,
indented, frame-aware log lines that read at a glance and land in the App
Builder's **Terminal** tab under the `[BACKEND]` prefix.

It's pre-installed in every App Builder workspace that has a backend (i.e.
after `bash backend_init.sh`). Use it instead of `print()`.

---

## Basic usage

```python
from swarm_debug import debug

debug("hello")                       # [endpoint_name] : hello
debug({"user_id": 42, "ok": True})   # [endpoint_name] : {'user_id': 42, 'ok': True}
debug(some_dataframe)                # auto-truncated to 3000 chars
```

The function reads the **calling line of source code** to extract the
variable name(s), so:

```python
result = compute_thing(input_data)
debug(result)
# prints: [my_endpoint] : result = {'sum': 42, 'rows': [...]}
```

Variable name is inferred from the AST of the line that called `debug()`. If
you pass a literal (string, number, raw dict), it just prints the value.

---

## Multiple args

Pass several values in one call — each is labeled separately:

```python
debug(user_id, request.body, response.status_code)
# [endpoint_name] : user_id = 42
# [endpoint_name] : request.body = {...}
# [endpoint_name] : response.status_code = 200
```

---

## Calling from inside a class

`swarm_debug` introspects the caller's frame, so methods on a class print
under `ClassName.method` instead of just `method`:

```python
class JobService:
    def fetch(self, query):
        debug(query)
# [JobService.fetch] : query = "machine learning engineer"
```

Indentation also scales with the call's lexical depth so nested-loop
debugging stays readable:

```python
for batch in batches:
    debug(batch.id)            # |\t[fn] : batch.id = 1
    for item in batch.items:
        debug(item)            # |\t |-- [fn] : item = {...}
```

---

## Error highlighting

Pass an `Exception` (or a name containing `err`/`error`) and `swarm_debug`
flips the color to red + prefixes a ❌ emoji so the error stands out in the
Terminal pane:

```python
try:
    risky_thing()
except Exception as err:
    debug(err)
    # ❌ [endpoint_name] : err = ValueError("bad input")
```

---

## Long values are truncated

By default `swarm_debug` cuts values longer than 3000 characters with a
`…\n…` separator in the middle. Override per-call:

```python
debug(huge_payload, override_max_chars=True)
```

---

## Modes (custom log levels)

`debug` accepts a `mode` kwarg that maps to a log channel. Valid values are
`'all'` (always shown), `'debug'` (the default), and `'test'` (high
priority). Anything else raises.

```python
debug(payload, mode='all')
debug(flaky_result, mode='test')
```

---

## More tools (pretty-print, tables, diffs, timing)

```python
debug(my_dict)                      # structured values pretty-print by default
debug(my_dict, pretty=False)        # force flat single-line output
debug(sql_query, lang="sql")        # syntax-highlight a string (sql, json, html, ...)
debug(x, y, z)                      # 2+ data args auto-render as a Name|Type|Value table
debug(x, y, z, table=False)         # force per-line instead
debug("a", "b", sep=", ")           # join args into one line, like print(sep=...)
debug("about to retry", error=True) # force red error styling on a non-exception

debug.diff(old_value, new_value)    # unified diff of two values
with debug.time("fetch users"):     # times the block, prints the duration
    rows = fetch_users()
```

---

## Visibility (why output might not show)

Output is gated per-file: only files toggled ON print. OpenSwarm re-toggles
every file ON at each backend boot, and new code needs a backend restart to
load anyway (no auto-reload), so in practice your `debug()` lines are always
visible after the restart that loads them. If you ever need to manage this
yourself, the CLI lives in the workspace venv:

```bash
.venv/bin/swarm-debug status              # what's toggled where
.venv/bin/swarm-debug toggle on --all     # everything visible (run from the workspace root)
```

---

## When to use `print()` instead

Don't. `swarm_debug.debug()` IS the answer for backend logging. Reasons:

- `print()` doesn't show the variable name or class/function context.
- `print()` doesn't truncate huge payloads.
- `print()` doesn't color-code errors.
- `print()` writes raw stdout, which is harder to scan in the Terminal
  pane when the agent is also running and producing output.

`print()` is fine for human-only one-off scripts the agent runs via Bash —
not for endpoint code.

---

## What NOT to do

- **Don't call `debug()` inside a hot loop** without a guard — every call
  reads the source file to extract variable names, which gets expensive
  at 10k+ iterations.
- **Don't pass functions / class objects** expecting useful output —
  you'll get something like `<function compute at 0x10a...>`. Call the
  function or stringify intentionally.
- **Don't rely on `debug()` for production logging.** It's a development
  aid. For structured server logs that survive past the App Builder
  session, use `logging` from the standard library.

---

## How it lands in the Terminal tab

Every line `debug()` prints goes to stdout/stderr of your backend
subprocess. The App Builder's runtime captures both streams, prefixes each
line with `[BACKEND]`, and streams them via WebSocket into the Terminal
pane in real time. Frontend `console.log` calls in the running app land in
the same Terminal pane prefixed `[FRONTEND]`. Use this to correlate cause
and effect across the two halves of your stack.

The same stream is tee'd to **`.openswarm/terminal.log`** at the workspace
root (reset on every app start), so you can read your own `debug()` output
directly: `tail -100 .openswarm/terminal.log`.

---

## Quick reference

| Want to… | Do this |
|---|---|
| Log a value with auto-inferred name | `debug(value)` |
| Log several values in one call | `debug(a, b, c)` |
| Log an exception with red coloring | `debug(err)` (variable name must contain "err" or "error", or pass an `Exception` instance) |
| Avoid truncation | `debug(value, override_max_chars=True)` |
| Always-shown log channel | `debug(value, mode='all')` |
| Diff two values | `debug.diff(old, new)` |
| Time a block | `with debug.time("label"): ...` |
| Flat instead of pretty-printed | `debug(value, pretty=False)` |
| Syntax-highlight a string | `debug(query, lang="sql")` |
