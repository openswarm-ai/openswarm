# frontend — conventions (TypeScript)

All conventions in the root `CLAUDE.md` apply here. The naming and structure rules carry over; the
Python-only rules do not. Specifically:

- **No leading `_`** on any name, and **no barrels** (`index.ts` that only re-exports).
- **Single-purpose file naming** — a one-export file is named after its export.
- **Type everything** under strict `tsconfig`; model data with typed interfaces, not untyped
  objects (the TS equivalent of "no bare dicts").
- **Does not apply (Python-only):** `@typechecked`, pydantic `BaseModel`, the no-relative-imports
  rule (the frontend uses the `@/` path alias and local relative imports), and `p-private`.

Known gaps to fix over time, not perpetuate: `no-underscore-names` / `p-private` are currently
backend-only, and `eslint.config.mjs` still suggests a `_` prefix to silence unused-variable
warnings — remove the unused binding instead of prefixing it.
