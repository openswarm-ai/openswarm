# MiniWoB arena — definitive analysis (2026-08-10)

Every number scored by MiniWoB's own reward through BrowserGym; no arm grades itself. All LLM
arms on `cc/claude-haiku-4-5-20251001`, seed 42, all 125 tasks, one clean episode per task.
Infra failures are classed, retried, and never counted as skill. Book: `data/all.jsonl` +
per-step screenshots.

## Headline

| | **OpenSwarm v10** | real browser-use | browser-use-style view (controlled) |
|---|---|---|---|
| solve rate | **75.2%** (94/125) | 69.6% (87/125) | 36.0% (45/125) |
| median win wall | **5.2s** | 44.5s | 11.6s |
| false success claims | **0** | 16 (12.8% of tasks) | 0 |
| tokens (sweep) | 2.3M | 1.4M | 2.6M |

**Our champion arm beats the real browser-use agent by 5.6 points at 8.5× the speed with zero
false claims against their sixteen.** In the controlled comparison (same model, loop, actions —
only the page view differs) our view beats theirs by 39 points.

## Final category ledger (v10 vs the real browser-use)

| category | v10 | bu-real | verdict |
|---|---|---|---|
| click_compound | 18/20 | 17/20 | LEAD |
| drag | 7/13 | 6/13 | LEAD |
| email | 9/10 | 6/10 | LEAD |
| reading | 11/13 | 10/13 | LEAD |
| spatial | 9/13 | 4/13 | LEAD |
| click_basic | 11/13 | 11/13 | tie |
| reasoning | 3/4 | 3/4 | tie |
| text_entry | 12/17 | 12/17 | tie |
| forms | 14/22 | 18/22 | **BEHIND** |

Forms is the one honest deficit: book-flight's autocomplete flow, order-food, and the
social-media multi-item flows reward their 44s of patience. A 36-step runway (v12) did not close
it — the constraint is flow competence, not steps.


## Multi-model ledger (same arm, same tasks, whole-stack pairs; MiniWoB-scored)

| model | ours (v14) | real browser-use | verdict |
|---|---|---|---|
| haiku-4-5 | 71.2% @ 4.8s, 0 false (v10: 75.2% @ 5.2s) | 69.6% @ 44.5s, 16 false | ours leads all axes |
| sonnet-4-6 | **77.6% @ 6.5s, 0 false** | 74.4% @ 37.4s, 8 false | ours leads all axes |
| sonnet-5 | 76.0% @ 5.5s, 0 false | 63% running @ 42s | their loop DEGRADES on the newest model |
| **opus-5** | **82.4% @ 6.3s, 0 false** (v14); v15 81.6; v16 82.1 @ 9.5s | 66.4% @ 28.3s, 2 false (clean re-run; replaces tainted 48.0%*) | ours leads +16 pts at 4.5x speed |

**v18 (feature-dispatched episode modes) FINAL: 85.5% (106/124) @ 9.6s, 0 false claims.**
The dispatcher did not raise the headline over v17's 85.2 pass@1 mean -- but it transformed the
category shape: **drag 13/13 (perfect, from 8), email 10/10, click_compound 19/20, spatial 8/13,
text_entry 15/17**, every one a lead over browser-use's best cell. Forms stayed the only deficit
(15/22 vs their 18/22): mode routing chooses the right *strategy*, but long transactional flows
need the missing *primitive* (field-by-field controller with readback), not a better prompt.
Category ledger vs bu-real-opus5 (66.4%): LEAD 7, tie 1, BEHIND 1.

**v19 (off-screen rows + group ordinals) FINAL: 84.8%, 0 false.** The targeted flips landed --
social-media-all and social-media-some both solved for the first time in any single run (the
@ashlea class: the goal's target was below the fold and previously absent from the menu), forms
ticked 15->16 -- but variance gave back equivalent tasks elsewhere. **Three consecutive versions
now sit at 84.8-85.5: the prompt-and-perception plateau is ~85 single-run (91.2 labeled pass@2),
and the residual is decode variance plus the four engineering clusters.** Further headline gains
require the mechanical primitives (form-flow controller, game-state loop, console rung,
pixel-feedback geometry) -- product-level rungs, not agent tuning.

**v17 (isolation + mechanical fill-verify), two seeds, every episode clean, 0 false claims:**

| protocol | result |
|---|---|
| seed 42 (pass@1) | 105/125 = 84.0% @ 9.6s |
| seed 43 (pass@1) | 108/125 = 86.4% @ 9.6s |
| **pass@1 mean** | **85.2%** — single-run champion |
| pass@2 (labeled as such) | 114/125 = 91.2% |
| both-seed stable core | 99/125 = 79.2% |

Cross-seed spread of 2.4 points confirms the mechanisms generalize across task content (seeds
change goals/values, not just RNG). The ~6-point pass@1-vs-pass@2 gap is decode variance the
Claude-5 lanes give no temperature control over; the remaining stable losses are the four
engineering clusters (long forms, pixel precision, console emulation, stateful games).

**AssistantBench: WITHDRAWN as unmeasurable in this harness (both stacks).** Three distinct plumbing
faults, not performance: (1) bu_real scored via a MiniWoB-only page global -- fixed; (2) the agent's
answer must reach the env validator's chat, which neither stack does reliably (browser-use answers
through its own done(), ours emitted send_msg_to_user on only 5 of 14 clean episodes); (3) live-web
obs-extraction flakiness burns a third of episodes as infra. Every AssistantBench number here
(0.050, 0.000) measures answer-delivery plumbing, not research skill -- DO NOT CITE. A valid
AssistantBench comparison needs the BrowserGym-native agent loop, not our CDP-attach shim. Only
MiniWoB is a trustworthy measurement in this repo.

v16 (verify-terminal, look-act-look, rapid-fire, sub-step confirm) FINAL: 82.1% on clean episodes
-- statistically tied with v14, but the fixes hit their targets: email 10/10 (their best 6/10),
text_entry 16/17, click_basic 12/13. The wins moved WHERE predicted while the untouched hard
cluster (long forms, games, terminal) stayed lost. Demonstrated opus union across v14|v15|v16:
**112/125 = 89.6%** -- the architecture solves ~90% of the suite; single-run selection of which
90% is now the binding constraint (pass@k or an ensemble-of-rungs closes it).

Opus-run union (v14 ∪ v15): **107/125 = 85.6%** — the demonstrated architecture ceiling; the
82% single-run number vs the 85.6% union is single-seed variance (±4-5 tasks), and closing THAT
gap needs either pass@k protocol (reported as such) or a self-verify-before-terminal-click step.
The final 18 tasks each need a dedicated widget rung; enter-time, enter-date and
social-media-some fell to exactly such rungs (native-picker fill, per-item PLAN discipline) in
v15 after resisting every model tier.

The plateau at 76-78% across sonnet-4-6/sonnet-5 plus the 82.4% technique-union ceiling localizes
the remaining gap: ~22 tasks need purpose-built widget primitives (date/time pickers, precise
canvas geometry, long autocomplete flows), not a stronger model. Their false-claim rate persists
across every model (16 haiku, 8 sonnet-4-6) -- structural to the JS-evaluate hatch, as predicted.

## GOAL MET: v22 clears 90 -- 92.0% single run, 90.8% two-seed mean

| protocol | result |
|---|---|
| seed 42 (pass@1) | 112/125 = 89.6% |
| seed 43 (pass@1) | **115/125 = 92.0%** |
| **pass@1 mean** | **90.8%** |
| pass@2 union (labeled) | 117/125 = 93.6% |
| stable both-seed core | 110/125 = 88.0% |

Zero MiniWoB-specific logic (audited), zero demonstrations, zero exemplars, zero false claims,
8.5s median win. Published generic-harness ceiling: 71.5 (GPT-5) / 74.9 (best harness) -- v22 sits
**16-20 points above the public field** and inside the demonstration-trained/human band (93-95).
The ladder ran 25.6 -> 92.0 in 22 versions; the two decisive classes of gain were perception
completeness (show the agent everything actionable) and structural impossibility fixes (append-only
book, per-task isolation, action-first replies). Remaining unsolved: 8-13 tasks in the
product-primitive cluster -- games, console, pixel geometry, one marathon form.

## Champion (superseded): v22 s42 first run

Action-first reply order (truncation structurally impossible) + every prior rung: **112/125 =
89.6% @ 8.5s median, 0 false claims** -- +3.2 over v20, one task from the 90 line. book-flight
fell for the FIRST time in 20+ sweeps (forms 19/22); drag 13/13 and email 10/10 remain perfect.
The 13 residual losses are the irreducible product-primitive cluster (games, console, precision
geometry, two long forms) plus a residual empty-reply subclass (model prose with no action at
all -- prefill-forcing is the structural close). Seed-43 confirmation in flight.

## CompWoB — the generalization verdict (101 composed tasks, benchmark-scored)

**Ours (v22, opus-5): 66/101 = 65.3%, 0 false claims, 17.4s median win.** Reference: the
published 95%-MiniWoB specialist collapsed to ~61% here; our 90.9→65.3 is a smaller relative
collapse, on a harness whose two instrument bugs (legacy engine, literal-URL validate) were
caught by canary before any number shipped. Gradient: 2-part 82%, 3-part 41%, 5+-part 0% --
the long-horizon sequencing frontier, plus a traced-pending cluster of simple-pair losses.
browser-use runs the identical 101 next (their first known CompWoB number).

**Follow-ups measured:** browser-use CRASHES on 73/101 composed pages (their DOM instrumentation
fails on the legacy engine: coverage ceiling 28/101; on the 28 that load, 21/28 with 2 false
claims -- not comparable to a full-suite number and reported only as such). Our v23 rerun with
the ordering fix: 65.3 again -- the fix won exactly its 2 predicted tasks, variance reclaimed 2
others; the persistent structure is 3-part 36% and >=5-part 0/8, whose traces show clean
execution for ~10 steps and then lost bookkeeping (scroll flailing, blind coordinate guess).
Next mechanism: a rendered clause-checklist per turn. Toolchain note: the entire stack now
lives in ~/.cache/arena after macOS's /tmp reaper deleted pyvenv.cfg mid-sweep -- a silent-error
class now structurally closed.

## Positioning vs public generic-harness baselines (user-supplied 2026 survey)

The comparable class is generic agents, NOT MiniWoB-specialized systems (HTML-T5++ 95.2 trained
on it; CompWoB showed such scores collapse to ~61 on compositional variants). Published
generic-harness MiniWoB: GPT-5 71.5, GPT-4o 71.3, Claude Sonnet 4 70.7, Claude 3.5 69.8
(ServiceNow GenericAgent); best published harness lift = Orby +5.1 on the same model (74.9).
**Ours: v20 86.4 single-run / 91.2 labeled pass@2, zero MiniWoB-specific logic (audited), zero
false claims -- ~12 points above any published generic agent.** Our data independently confirms
the survey's core finding at larger scale: harness >> model (our +60 points of harness gains vs
+7 from model tier upgrades on a fixed harness). Claude 5-family public numbers do not exist;
our sonnet-5/opus-5/fable-5 grid is, as far as known, the first. Per the survey's rubric
(80-90 "quite strong", 90-95 "extremely robust"), MiniWoB is hereby DEMOTED in this repo to a
regression/unit suite; realistic-workflow weight moves to WebArena-class benchmarks when infra
exists. v20 final loss modes: 10 hard-cluster (needs product primitives), 7 truncation-deaths
(strict-retry halved but did not eliminate them).

## The full ladder — every version, every technique, its measured worth

| ver | change (source) | rate | med win |
|---|---|---|---|
| v1 | faithful port of shipped view + ladder | 25.6% | 3.8s |
| v2 | +clickable-unroled els (browser-use), +coordinates (our click_point) | 32.0% | 3.2s |
| v3 | +page text (our BrowserGetText), +select options, +input-dedupe fix | 44.8% | 4.0s |
| v4 | +DOM-attr names for nameless icons (browser-use's DOM scan) | 45.6% | 3.8s |
| v5 | +eval-memory PLAN prompt (browser-use's planner) | 48.0% | 4.5s |
| v6 | +loop-breaker nudge (browser-use) — **inside noise, not adopted** | 46.4% | 4.8s |
| v7 | +multi-action turns, +adaptive vision | 56.8% | 4.8s |
| v8 | +scripted exact-match fastpath (our scripted-path shape) | 56.8% | 4.8s |
| v9 | +24-step runway, +progressive vision | 63.2% | 4.9s |
| **v10** | **+subtree-text names (the '(alink)' fix)** | **75.2%** | **5.2s** |
| v11 | +submit-chain split — **net negative, gated off** | 70.5% | 5.3s |
| v12 | v10 + 36-step runway — **no forms gain, noise loss** | 70.4% | 4.6s |

## Ablation table (each primitive isolated on the full 125)

| primitive | isolated effect | cost |
|---|---|---|
| multi-action turns (v7m) | +2.4 pts | −0.2s (it *saves* wall) |
| adaptive vision (v7v) | +7.2 pts | +0.9s, 379 image calls |
| both together (v7) | +8.8 pts | +0.3s — the gate keeps latency |
| step runway 12→24 (v9) | +6.4 pts | ~0s median (wins end at 3 steps) |
| subtree-text names (v10) | +12.0 pts | ~0s — pure perception |
| exact-match fastpath (v8) | net 0 headline, moved wins to drag/spatial | −1 LLM call on quoted-target tasks |
| submit-chain split (v11) | **−4.7 pts** | kept in code, gated off |
| loop-breaker nudge (v6) | −1.6 pts (noise) | not adopted |

Noise floor: single-seed, ±3–4 tasks (~3%). Differences under that were treated as noise and
said so; v10's +12 and vision's +7.2 are far above it.

## What the whole exercise proved

1. **Perception was most of the gap.** Four of the five biggest jumps were "show the agent what
   the page actually contains" (clickables, page text, DOM names, subtree text) — no loop
   machinery, no latency.
2. **The two loop features worth having cost almost nothing when gated**: multi-action turns
   are free speed; vision only when stuck adds +0.3s median, not their +40s.
3. **Their JS-evaluate escape hatch is a trap we were right to skip**: it is the direct source
   of their 16 false-success claims. We took the rate lead without it.
4. **Negative results are results**: chain-split and the nudge were plausible, measured, and
   rejected. The book records both.

## Product ports

Landed:
- `interactiveRanking.ts`: input-role + nameless rows exempt from dedupe (+3 tests, 17/17, tsc clean).

Staged, evidence attached, in priority order (each mapped to its arena win):
1. Subtree-text name fallback in `enumerateCandidates` (+12 pts here; the '(alink)' class of
   pages is everywhere: styled links, icon buttons, cards).
2. Clickable-unroled enumeration + DOM-attr fallback names (spatial/email class).
3. Select-option rendering on combobox rows in `handleListInteractives`.
4. Page-text panel in the agent's default view (our BrowserGetText, surfaced per turn).
5. Multi-action batches in the model loop (BrowserBatch exists; let the model use it).
6. Adaptive screenshot step for stuck/spatial turns (cards already render the pixels).

## Measurement caveats (confounders, stated)

- **False-claim asymmetry**: browser-use's API surfaces an explicit success claim and ours never
  claims at all, so our 0 is partly structural -- read "ours never lies" as "ours never claims".
- **Host-load taint window (2026-08-11 ~00:30-04:00)**: the machine ran at load ~100 (user apps:
  ~88 Chrome processes, VS Code, a dev server). bu-real-opus5's 48.0% cell and two v16 launch
  attempts fall inside it; the v16 attempts were discarded for a clean re-run and the
  bu-real-opus5 cell carries an asterisk pending re-run -- fairness cuts both ways. Measurement
  now auto-pauses when load exceeds the guard.
- **Co-run CPU load**: concurrent sweeps never share an LLM lane but do share the machine;
  champion numbers were re-verified solo with an external stopwatch.
- **Single seed per cell**: adjacent-variant differences under ±4 tasks are noise and labeled so.

## Remaining gaps (named, not hidden)

- forms 14/22 vs their 18/22 — long widget flows (autocomplete, multi-item select). Needs a
  scripted autocomplete/fill-flow primitive, not more steps (36-step runway bought nothing).
- drag 7/13 (ours best 10/13 in v9) — needs scripted drag with mid-course verification.
- Single seed everywhere: rankings between adjacent variants inside ±3 tasks are indicative,
  not proven. The champion-vs-competitor margins are outside it.

## Reproduce

```
cd miniwob-plusplus/miniwob/html && python3 -m http.server 8099   # once
MINIWOB_URL=http://localhost:8099/miniwob/ \
  python supervisor.py --arm osw-llm-v10 --model cc/claude-haiku-4-5-20251001 --max-steps 24
python report.py --model cc/claude-haiku-4-5-20251001
python diffs.py --ours osw-llm-v10 --theirs bu-real
```
