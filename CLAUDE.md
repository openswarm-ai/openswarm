# OpenSwarm — code conventions

These conventions are **mandatory** and apply to the **whole codebase**. This file is loaded into
every agent session (and, hierarchically, the nearest `CLAUDE.md` for the files you touch), so the
rules are present wherever you work. They are enforced where possible by the linter
(`linter/lint.py`; see `linter/README.md` for the full rationale and how to run it); the rest are
followed by hand. Per-package `CLAUDE.md` files (`backend/`, `frontend/`) restate the
language-specific subset.

Personal / per-machine notes go in `CLAUDE.local.md` (gitignored), **not** here.

## Naming & access
- **Never start any name with `_`** (functions, variables, arguments, attributes, import aliases).
  A leading underscore makes dead-code tooling (Pylance, ruff, vulture) treat the name as
  intentionally unused and stop reporting it — a blind spot. Use `p_` for "private" instead.
  Dunders (`__init__`) and the bare `_` throwaway are the only exceptions.
  *(Enforced backend: `no-underscore-names`.)*
- **`p_` is an access boundary, not decoration.** A `p_` name is private to its file (module level)
  or class (attribute). If it is read or imported anywhere else, it is not private — drop the prefix
  and make it public. *(Enforced backend: `p-private`.)*

## Structure
- **No barrels.** Never write an `__init__.py` / `index.ts` whose only job is to re-export. Import
  from the defining module directly.
- **No relative imports (Python).** Always import from the package root
  (`from backend.apps.foo import bar`), never `from .foo import bar`.
- **Single-purpose file naming.** A file that exports exactly one function or class is named exactly
  after it.
- **File and folder size caps** (`max-file-lines`, `max-folder-items`) — split when you exceed them.
- **No runtime import cycles** (`import-cycles`).

## Types
- **Type everything** — every function, argument, and variable is annotated.
- **Backend Python:** decorate with typeguard's `@typechecked`; prefer `typing` generics
  (`List`, `Dict`, `Optional`) over the builtins; code also type-checks under Pyright/Pylance strict.
- **Frontend:** strict `tsconfig`; model values with typed interfaces, never untyped objects.

## Classes & data (Python)
- **Classes are pydantic `BaseModel`** with `model_config = ConfigDict(validate_assignment=True)`;
  wrap unrecognized field types in `InstanceOf[...]`.
- **Avoid bare `dict`s for structured data** — model it as a `BaseModel`. The only legitimate dicts
  are dynamic-key maps (a registry keyed by a runtime id) and external protocol shapes (the Claude
  Agent SDK hook returns, `model_dump` output).

When you add or change code, the files you touch must be clean under these rules. Pre-existing debt
in files you are not otherwise editing is grandfathered via the linter's exception lists — do not
mass-migrate untouched files.
