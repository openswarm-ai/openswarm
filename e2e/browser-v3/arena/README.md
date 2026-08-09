# MiniWoB arena

Every browser stack we care about, scored on the same 125 MiniWoB tasks by MiniWoB itself.
Nothing in this directory decides success; the reward comes from the task's own JS
(`WOB_REWARD_GLOBAL`), read through BrowserGym. That is the property none of our other suites
have, and it is why cross-stack claims ("ours is better/worse than X") should cite THIS data.

## Arms

| arm | what it is | entrypoint |
|---|---|---|
| `flat` | no-LLM floor: flat axtree, first label match | `run.py --arm flat` |
| `openswarm` | no-LLM port of our shipped perception + action ladder | `run.py --arm openswarm` |
| `bu` | LLM given a browser-use-shaped flat axtree dump | `run.py --arm bu` |
| `osw-llm` | same LLM given our ranked/deduped/capped element menu | `run.py --arm osw-llm` |
| `bu-real` | the actual browser-use agent, attached over CDP | `bu_real.py` |
| `sh-real` | the actual Stagehand agent, attached over CDP | `sh_real.py` |

`bu` vs `osw-llm` is the controlled experiment (same model, same action layer, only the page view
differs). `bu-real`/`sh-real` are the shipping competitors, whole-stack.

## Ground rules

- One recorder (`recorder.py`): every episode appends to `data/all.jsonl`; screenshots under
  `data/shots/<run>/<arm>/<task>-s<seed>/`. Reruns supersede by `started_at`; nothing is rewritten.
- Agents never grade themselves. `claimed_success` vs `success` is recorded precisely to count
  false-success claims per arm.
- Infra failures (`error_class` starting `infra`) are excluded from rates but always reported.
- `ranking.py` must stay line-for-line with `frontend/src/shared/interactiveRanking.ts`; if either
  changes, change both.

## Running

```
# serve MiniWoB HTML once:  cd miniwob-plusplus/miniwob/html && python3 -m http.server 8099
MINIWOB_URL=http://localhost:8099/miniwob/ python run.py --arm osw-llm --tasks all --seeds 1
python report.py            # scoreboard; --md ARENA.md for the markdown version
python diffs.py --ours osw-llm --theirs bu-real   # evidence trail for every loss
```

Needs the browsergym venv (Python 3.12 — 3.13 cannot build greenlet 3.0.3).
