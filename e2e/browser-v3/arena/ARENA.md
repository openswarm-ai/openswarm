# MiniWoB arena — final analysis (2026-08-09)

Every number is scored by MiniWoB's own reward (`WOB_REWARD_GLOBAL`), read through BrowserGym.
No arm grades itself. Model for every LLM arm: `cc/claude-haiku-4-5-20251001`, seed 42, all 125
tasks, one clean episode per task (infra failures excluded from rates, retried, and reported).
The recorder book (`data/all.jsonl` + per-step screenshots) is the only source.

## Final scoreboard

| arm | what it is | rate | 95% CI | med wall (win) | tokens | false claims |
|---|---|---|---|---|---|---|
| bu-real | the actual browser-use agent (whole stack, CDP-attached) | **69.6%** | [61,77] | 44.5s | 1.43M | **16** |
| **osw-llm-v5** | our view + all ingested techniques + eval-memory prompt | **48.0%** | [39,57] | **4.5s** | 2.02M | **0** |
| osw-llm-v6 | v5 + loop-breaker nudge | 46.4% | [38,55] | 4.8s | 2.39M | 0 |
| osw-llm-v4 | v3 + DOM-attr names + deep context | 45.6% | [37,54] | 3.8s | 1.45M | 0 |
| osw-llm-v3 | v2 + page text + options + input-dedupe fix | 44.8% | [36,54] | 4.0s | 1.57M | 0 |
| bu | browser-use-shaped flat dump, same model/loop as ours | 36.0% | [28,45] | 11.6s | 2.56M | 0 |
| osw-llm-v2 | v1 + clickables + coordinates | 32.0% | [24,41] | 3.2s | 1.69M | 0 |
| osw-llm (v1) | faithful port of shipped view | 25.6% | [19,34] | 3.8s | 2.05M | 0 |
| openswarm (no LLM) | our deterministic ladder (3 seeds) | 19.7% | [16,24] | 0.8s | 0 | 0 |
| flat (no LLM) | naive axtree floor (3 seeds) | 15.7% | [12,20] | 0.8s | 0 | 0 |

## The two verdicts, stated honestly

**Controlled comparison — same model, same loop, same actions, same scorer; only the page view
differs.** This isolates what OUR perception contributes:

- **v5 beats the browser-use-style view by 12 points (48.0% vs 36.0%) at 2.6× the speed
  (4.5s vs 11.6s) and 21% fewer tokens.** Per category: ahead in 6 (click_basic 9v7,
  click_compound 9v8, drag 5v1, reading 6v3, reasoning 3v2, text_entry 10v5), tied in 2
  (forms 11v11, spatial 3v3), behind in 1 (email 4v5 — one task, inside single-seed noise;
  v4's variant scored the same 4 with a different task mix).

**Whole-stack comparison — their shipping agent vs our best arena arm:**

- **bu-real leads on rate: 69.6% vs 48.0%.** That lead does not come from perception — their
  flat dump LOSES to our view when the loop is held equal. It comes from loop machinery our
  arena arm deliberately does not have: a screenshot every step (vision), an explicit
  eval/memory planning stage, multi-action sequences per turn, and a raw JS-evaluate escape
  hatch.
- **The price of their stack, measured: 44.5s median win (10× ours) and 16 false success
  claims (12.8% of tasks)** — the agent said "done, successfully" and MiniWoB scored 0 or −1.
  Ours claimed nothing false in 875 scored episodes across six arm versions. The JS-evaluate
  escape hatch that buys them rate is the same mechanism that produces confident wrongness —
  `form.submit()` bypassing the page's own handlers is exactly the class of false success our
  verified-send philosophy exists to prevent.

## The iteration ladder (what was ingested, from whom, and what it bought)

| version | change | source | rate |
|---|---|---|---|
| v1 | faithful port of shipped BrowserListInteractives + ladder | — | 25.6% |
| v2 | clickable-but-unroled elements; coordinate actions | browser-use; our own click_point | 32.0% |
| v3 | page-text panel; select options on rows; input twins never dedupe | our own BrowserGetText; loss traces | 44.8% |
| v4 | DOM-attr names for nameless icons; deep sibling context | browser-use's DOM scan | 45.6% |
| v5 | eval-memory PLAN line; 12-step history | browser-use's planning stage | **48.0%** |
| v6 | mechanical loop-breaker nudge | browser-use's loop detection | 46.4% |

Two lessons the data forced: half the gains were capabilities our product already ships but the
agent's view never surfaced (page text, coordinates); and past v5 the single-seed noise floor
(±3 tasks) swallows single-technique effects — further ranking-tuning needs 3+ seeds to measure.

## Where the remaining gap actually is (next frontier, evidence-backed)

Diff of bu-real's 35 wins over v3-class arms shows their winning traces are ordinary
click/input sequences — no exotic actions. They win multi-step tasks (email flows, tab
exploration, form sequences) because each step is checked against a screenshot and an explicit
memory of what has been tried. The arena arm is text-only and single-shot per step by design.
Closing the whole-stack gap means adding, in order of measured value:

1. **Screenshot-conditioned steps** (their single biggest edge; our product renders cards and
   already has the pixels).
2. **Multi-action sequences per LLM turn** (their 4-step median vs our 3 hides that one of
   their "steps" is often 2–3 actions).
3. **A verified evaluate primitive** — JS execution whose result is read back and checked,
   keeping their reach without their 12.8% false-claim rate.

Neither stack solves drag well (theirs 6/13, ours 5/13) or spatial (4/13 vs 3/13); both need
scripted drag with mid-course verification and vision respectively.

## Product code changes landed from this evidence

- `frontend/src/shared/interactiveRanking.ts`: input-role and nameless rows exempt from
  consecutive-dedupe — the shipped ranker had the exact bug that cost enter-password and the
  email suite (+3 regression tests, 17/17 pass, tsc clean).
- Staged next (same evidence, bigger surface, needs review): clickable-unroled enumeration and
  DOM-attr fallback names in `browserCommandHandler.ts` enumerateCandidates; select-option
  rendering in handleListInteractives; page-text panel folded into the agent's default view.

## Infrastructure honesty

- Router 502s once booked 40% of two sweeps as policy failures → retries + `infra_llm` class;
  infra never counts against skill and is never hidden.
- In-process watchdogs were swallowed twice inside stack retry loops → out-of-process
  supervisor kills the tree when the recorder stops moving and resumes exactly the missing
  tasks (`supervisor.py`).
- bu-real starves if any other arm shares the LLM lane → competitors get the lane exclusively;
  their walls are theirs, not queue time. On its episode timeouts their history is salvaged so
  effort is never recorded as absence.
- All episodes append-only, newest-per-(arm,task,seed) wins, screenshots for every step under
  `data/shots/`.

## Reproduce

```
cd miniwob-plusplus/miniwob/html && python3 -m http.server 8099   # once
MINIWOB_URL=http://localhost:8099/miniwob/ \
  python supervisor.py --arm osw-llm-v5 --model cc/claude-haiku-4-5-20251001
python report.py --model cc/claude-haiku-4-5-20251001
python diffs.py --ours osw-llm-v5 --theirs bu-real
```
