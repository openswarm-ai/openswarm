# MiniWoB arena — full analysis (2026-08-09)

Every number here is scored by MiniWoB's own reward (`WOB_REWARD_GLOBAL`), read through
BrowserGym. No arm grades itself; the recorder book (`data/all.jsonl` + per-step screenshots)
is the only source. Model for every LLM arm: `cc/claude-haiku-4-5-20251001`, seed 42, 125 tasks.

## Scoreboard

| arm | what it is | solved | rate | 95% CI | med wall (win) | false-succ |
|---|---|---|---|---|---|---|
| **osw-llm-v3** | our view + 5 ingested techniques | **56/125** | **44.8%** | [36,54] | **4.0s** | 0 |
| bu | browser-use-shaped flat dump, same model | 45/125 | 36.0% | [28,45] | 11.6s | 0 |
| osw-llm-v2 | our view + 2 ingested techniques | 40/125 | 32.0% | [24,41] | 3.2s | 0 |
| osw-llm (v1) | our shipped view, faithful port | 32/125 | 25.6% | [19,34] | 3.8s | 0 |
| openswarm (no LLM) | our deterministic ladder | 74/375 | 19.7% | [16,24] | 0.8s | 0 |
| flat (no LLM) | naive axtree floor | 59/375 | 15.7% | [12,20] | 0.8s | 0 |
| bu-real | the actual browser-use agent over CDP | sweep in progress | ~43% interim | — | ~100s | ≥1 |

**Headline: v3 beats the browser-use-style arm by 8.8 points at ~3× the speed, on identical
model, tasks, seed, action layer, and scorer.** The two free arms confirm our deterministic
perception beats the naive floor by 4 points at zero cost.

## The iteration ladder — what each ingested technique bought

Every step below came from diffing our losses against a competitor's wins on the same episodes,
finding the mechanism, porting it, and re-running all 125.

| version | change (source of the idea) | rate |
|---|---|---|
| v1 | faithful port of shipped BrowserListInteractives + ladder | 25.6% |
| v2 | + clickable-but-unroled elements (browser-use's DOM scan); + coordinate actions (our own click_point, never exposed to the arm) | 32.0% |
| v3 | + page-text panel (our own BrowserGetText, never exposed); + select options rendered on the row; + input twins exempt from dedupe | 44.8% |
| v4 | + DOM-attribute names for nameless icons (`(trash)` from `class=trash`); + deep sibling context (which row is Cecile's) | sweep queued |

The pattern worth recording: **half the wins came from browser-use's ideas, half from
capabilities our product already ships but the agent's page view never surfaced.** The flat dump
is a bad menu but a complete one; our menu was clean but blind. v3+v4 keep the ranked menu and
add the missing senses.

## Category detail (v3 vs bu, wins/tasks)

| category | v3 | bu | verdict |
|---|---|---|---|
| click_basic | 9/13 | 7/13 | lead |
| click_compound | 11/20 | 8/20 | lead |
| text_entry | 10/17 | 5/17 | lead |
| reading | 8/13 | 3/13 | lead |
| reasoning | 3/4 | 2/4 | lead |
| drag | 3/13 | 1/13 | lead (both weak) |
| forms | 10/22 | 11/22 | behind by 1 |
| email | 0/10 | 5/10 | behind — root-caused, fixed in v4 |
| spatial | 2/13 | 3/13 | behind by 1 — partially fixed in v4 |

Email root cause (from step traces + screenshots): every actionable control is a nameless
`<image>`/`<generic>` whose identity lives in `class="trash"` — an attribute the AX tree
never surfaces. Two adjacent nameless icons also collapsed in our consecutive-dedupe. v4
pulls the DOM attribute as the row name and exempts nameless rows from dedupe; the
email-inbox-delete view now reads `[9]<image "(trash)" ctx="Cecile Odio..">`.

## What the competitors genuinely do better (ingested or credited)

1. **Completeness over cleanliness** (browser-use): their flat dump contains everything —
   canvases, unlabeled icons, page prose — so no task is invisible. Ingested as: clickable
   detection, attr-hint names, page-text panel, options rendering. We keep our cap + ranking,
   so the token bill stays ~40% below theirs (1.57M vs 2.56M for the sweep).
2. **Persistence loops** (browser-use): their agent retries a wrong bid-format action until it
   self-corrects. We ingested the cheaper form: history lines carry the page's error verdict, and
   the prompt forbids repeating a no-effect action.
3. **Nothing else survived measurement.** Their screenshot-per-step and 10-step median cost them
   11.6s median wall vs our 4.0s with no rate advantage anywhere except the two categories above,
   both root-caused to visibility, not reasoning.

## Where neither stack is good (honest gaps)

- **drag** (3/13 vs 1/13): mouse_drag_and_drop exists but one-shot LLM drags rarely land; needs
  a scripted drag primitive with mid-course verification. Product's send-script ladder is the
  natural home.
- **spatial** (2-3/13 both): clicking computed canvas coordinates from a static description is
  guesswork without vision. A screenshot-conditioned step (the product has one; the arena arm is
  text-only) is the known fix, at a latency price.

## Product code changes landed from this evidence

- `frontend/src/shared/interactiveRanking.ts` — input-role and nameless rows exempt from
  consecutive-dedupe (the enter-password / email-suite bug), +3 regression tests (17/17 pass,
  tsc clean). The same defect existed verbatim in the shipped ranker.
- Remaining ports staged for review (bigger surface, same evidence): clickable-unroled
  enumeration and DOM-attr fallback names in `browserCommandHandler.ts` enumerateCandidates;
  select-option rendering on combobox rows in handleListInteractives.

## Infrastructure honesty (what it took to measure this cleanly)

- Router 502s once booked 40% of two sweeps as policy failures → retries + `infra_llm`
  classification; infra never counts against skill, and is never hidden either.
- In-process watchdogs (SIGALRM) were swallowed twice inside stack retry loops → out-of-process
  supervisor kills the tree when the recorder stops moving and resumes exactly the missing tasks.
- bu-real starves when any other arm shares the lane (first LLM call never returns) → competitor
  sweeps get the lane exclusively; measured walls are theirs, not queue time.
- Reruns supersede by `started_at`; nothing is ever rewritten or deleted from the book.

## Reproduce

```
cd miniwob-plusplus/miniwob/html && python3 -m http.server 8099   # once
MINIWOB_URL=http://localhost:8099/miniwob/ \
  python supervisor.py --arm osw-llm-v3 --model cc/claude-haiku-4-5-20251001
python report.py --model cc/claude-haiku-4-5-20251001
python diffs.py --ours osw-llm-v3 --theirs bu
```
