# Arena data store — everything, one place

This directory is the single source of truth for every measurement in the arena. Nothing here is
ever rewritten; reruns append and reports keep the newest episode per (arm, model, task, seed).

| path | contents |
|---|---|
| `all.jsonl` | every episode ever run, all arms, all models, all benchmarks — full metadata (goal text, reward raw+discounted, claim-vs-truth, wall/setup/first-action seconds, steps, tokens, LLM calls, error class) plus per-step records (action, think/act/perceive ms, tokens, vision flag, retries, page URL, error verdict, screenshot path) |
| `<arm>.jsonl` | the same rows, sliced per arm for fast reads |
| `shots/<run>/<arm>/<task>-s<seed>/NN.png` | what the agent saw at each step; `99.png` = final frame |
| `logs/` | raw stdout of every sweep and supervisor round, including browser-use's own internal agent logs (its plans, evals, memory lines) |
| `MANIFEST.md` | this file |

Benchmarks recorded: MiniWoB (125 tasks; benchmark's own reward), AssistantBench validation
(33 live-web questions; official question_scorer accuracy). Models: haiku-4-5, sonnet-4-6,
sonnet-5, opus-5, plus early sonnet-4-6 partials. Stacks: ours (v1–v16) and real browser-use.

Query tools live one directory up: `report.py` (scoreboards), `diffs.py` (task-level evidence
trails between any two arms).
