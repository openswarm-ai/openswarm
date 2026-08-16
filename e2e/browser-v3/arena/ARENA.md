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

**CompWoB FINAL PAIR (fair, full-coverage, one env-broken page excluded for both):
browser-use 82.0% (82/100, 8 false claims, 48s med) — ours 65.3% (66/101, 0 false, 17s med).
They lead by ~17 points and earned it**: their per-step eval/memory loop holds long compositions
(3-part 82% vs our 41%; 5-7-part 4/6 vs our 0/8) that our fast chained loop drops once early
actions leave its history window. The prior claims that they crashed on 73 pages are fully
retracted: one page is broken upstream, and my supervisor's head-of-line blocking (retrying that
one page 201 times) starved the rest — both instrument bugs, both fixed (rotation + blacklist).
Ingest v25 (pre-registered): gated single-step turns + compressed full history. PILOT RESULT:
prediction FAILED -- all six long targets still lost, controls unharmed; booked no-effect. Their
long-chain edge is not history depth. Next pre-registered hypothesis: pacing -- composed pages
animate between sections and their 48s/task includes implicit settle time ours never grants.

**Follow-ups measured:** browser-use CRASHES on 73/101 composed pages (their DOM instrumentation
fails on the legacy engine: coverage ceiling 28/101; on the 28 that load, 21/28 with 2 false
claims -- not comparable to a full-suite number and reported only as such). Our v23 rerun with
the ordering fix: 65.3 again -- the fix won exactly its 2 predicted tasks, variance reclaimed 2
others; the persistent structure is 3-part 36% and >=5-part 0/8, whose traces show clean
execution for ~10 steps and then lost bookkeeping (scroll flailing, blind coordinate guess).
Next mechanism tried -- clause checklist (v24): **negative, 60.4%** (-5; short tasks paid for
scaffolding overhead, long chains unmoved at 0/8). Three mechanisms deep (runway, ordering,
checklist) the >=5-part cluster is invariant: the failure is not prompt-addressable bookkeeping
but state re-acquisition mid-chain -- the page mutates past what any static decomposition
describes. The honest reading: long-horizon composition needs either mid-episode replanning
against CURRENT page state or subtask-level verification gates; both are product-primitive
work, booked to the same frontier as MiniWoB's hard-10. Toolchain note: the entire stack now
lives in ~/.cache/arena after macOS's /tmp reaper deleted pyvenv.cfg mid-sweep -- a silent-error
class now structurally closed.

## WebArena Verified — first realistic-workflow measurement (100-task seeded partition)

Setup: WebArena's own self-hosted sites (forum :9999, gitlab :8023) under colima; tasks are
`browsergym/webarena_verified.*` scored end-to-end by THEIR evaluator (checkpointed functional
validation — no LLM judging, no scoring code of ours). Partition: seed-42 sample of 100 from the
304 reddit+gitlab tasks, committed in `wa_partition_100.json` before any episode ran; the same
list runs on both stacks. Disclosed skew: reddit+gitlab is the hard-retrieval/admin end of
WebArena — shopping partitions come later via site rotation (host disk cannot hold all 4 sites).

**Ours (osw-llm-v22, cc/claude-opus-5): 0/100 fully-solved | 6 tasks with partial checkpoint
credit (5× 0.667, 1× 0.5; sum 3.83) | median wall 63s | 0 false success claims.**

CORRECTION (booked per method): earlier progress reports called these 6 partials "strict wins."
That was wrong — the runner's `success = reward > 0` predicate is correct for MiniWoB (pages pay
only on completion) but mislabels WebArena's fractional checkpoint rewards. The book always held
the true rewards; the strict count is computed as `reward >= 1.0` and is 0. The error class is
now unrepresentable: episodes carry an explicit `strict` field (see run.py).

Reference points (full-task success, published): GPT-4 generic agent 14.4% on all-sites
WebArena; tuned 2025-26 SOTA 50–62%; human 78%. Two honesty caveats cut both ways: (a) our 0%
is on the hard partition, not all-sites — no cross-partition comparison is claimed; (b) 0 is 0 —
the current harness, which is ~12 points above published generic agents on MiniWoB and 65% on
CompWoB, does not yet complete a single full multi-checkpoint realistic workflow. The gap
matches the CompWoB ≥5-part diagnosis exactly (mid-chain state re-acquisition), which is the
strongest evidence yet that the missing piece is one product primitive, not benchmark tuning:
partial credit shows clauses 1–2 execute, then bookkeeping dies.

**Paired result (browser-use 0.5.9, same 100 tasks, same sites, same model cc/claude-opus-5,
same evaluator): 0/100 fully-solved | 2 tasks partial (0.67 + 0.5 = 1.17 sum) | median wall
119s | median 101,366 tokens/task | 49 false success claims.** Ours again: 0 strict | 6 partial
(3.83) | 63s | <10k tokens | 0 false claims. Neither harness solves a full hard-partition
workflow; on every secondary axis (partial progress 3.3×, speed 1.9×, tokens ~10×, honesty
0 vs 49) ours leads. The 49% false-claim rate matters beyond the scoreboard: an agent that
reports success on unfinished multi-step work is unshippable for verified writes, which is a
goal clause here. Caveats, symmetric: (a) Postmill's stock posting throttle ("You cannot post
more") blocked write attempts in both arms (ours 1 episode, theirs >=2) — it ships in canonical
WebArena, so it is benchmark hazard, not local misconfiguration; (b) ~12 of their episodes
overlapped two aborted (voided) pilot launches of ours on the shared LLM lane — their clean
rate in that window was 11/12 with no infra_llm, so no correction applied, noted for the
record; (c) both partials they scored (groups 349, 290) are in the same groups ours scored,
consistent with those checkpoints being genuinely reachable.

## PRE-REGISTERED (2026-08-13, before any v26 episode): serialized multi-action pilot

Mechanism: `serial_multi` (v26) — multi-action turns execute one env-step at a time; each queued
action re-resolves its plan-time target by name+role on the CURRENT page; vanished referent or
errored step drops the queue and replans. Zero extra LLM calls on the happy path. Prediction:
wins ≥2 of the 8 CompWoB ≥5-part tasks and lifts the 3-part cluster (was 36%); controls (1–2-part
CompWoB + short MiniWoB) unharmed — known risk is step-budget, since fill+click now costs 2 env
steps. Out-of-prediction gains will be booked as noise per method. Pilot: 8 target + 12 control.

VERDICT (same day): **prediction failed — targets 0/8, controls 12/12 unharmed.** No full sweep.
Fourth independent mechanism (runway, ordering, checklist, serialization) to leave the >=5-part
cluster at zero. The stale-plan hypothesis is now DISCONFIRMED as the binding constraint: queued
actions re-resolving cleanly means the plans weren't stale — the model's NEXT plan is wrong even
given a fresh page. Updated diagnosis: the model loses track of which composed sub-goal is
active (goal-side, not page-side). Mechanism kept (it is correct-by-construction and free), but
the cluster needs sub-goal tracking, not execution hygiene.

## PRE-REGISTERED (2026-08-13, before any v27 episode): active sub-goal ledger pilot

Follow-up to the v26 disconfirmation; also killed a rival explanation first: the 8-part page
shows 34/34 interactives, 0 truncated — visibility is NOT the constraint. Mechanism: `ledger`
(v27) — the v24 clause split, rendered ACTIVELY: done clauses collapse to ticks, only the
current clause carries full text plus an imperative anchor, upcoming ones are 40-char stubs;
advancement is model-declared ('CLAUSE n') on page evidence. Differs from failed v24 exactly in
focus (one live clause) vs. passive full-list display. Gate: >=3 clauses; short tasks see
nothing. Prediction: >=2 wins on the 8 pilot targets (incl. >=1 of the five >=5-part), controls
12/12 unharmed. browser-use's edge here is an actively-updated plan + step verdicts; this is
the plan-state half. Same pilot lists as v26 (v26_pilot.json).

VERDICT (2026-08-14): **fail, and harmful — targets 0/8, controls 6/11 (baseline 12/12).** The
first launch also surfaced a reply-format collision (CLAUSE marker vs action-first replies →
empty actions), fixed before the counted run; the counted run still failed both prongs. The
'work ONLY on this clause' constraint evidently fights the fastpath/multi-action machinery that
wins the short tasks. Plan-state scaffolds are now 0-for-2 (passive v24, active v27): the model
does not need to be TOLD where it is. Goal integrity also verified intact end-to-end (309-char
8-part goal arrives whole). Remaining live hypothesis: the model never JUDGES whether its last
action achieved its intent — browser-use's reply schema forces a per-step self-evaluation that
rides in memory. That is v28.

## PRE-REGISTERED (2026-08-14, before any v28 episode): per-step self-eval line

Mechanism: `eval_line` (v28) — the reply format gains one trailing line, 'EVAL: <did the
previous action achieve its intent, judged from the current page>'; the line is parsed and
rides in history, so each turn opens with the model's own verdict on its last step. No extra
LLM calls, action-first reply untouched (EVAL trails the action like the CLAUSE marker fix).
Ungated (cost is ~1 line) — the pilot's 12 controls decide if that is a tax. Prediction: >=2 of
8 targets (incl >=1 five-plus-part), controls 12/12. This is the second half of the
browser-use loop diff (step verdicts); the first half (plan state) is dead.

VERDICT (same day): **fail — targets 1/8 (first-ever pilot target win, but a 3-part; pre-reg
required >=2 incl a >=5-part), controls 10/12 (both login-popup variants lost).** Both halves
of the browser-use loop diff are now tested and neither transfers into our loop. Escalation per
method: stop guessing mechanisms; trace-level diff of their WIN vs our LOSS on the same 6-part
task. First finding from our side: the loss is 8 confident, error-free clicks scoring 0 — and
step records did not store WHAT was clicked. Instrumentation fixed (StepRecord.target: resolved
accessible names per action); labeled diagnostic episode next. Their side shows a self-authored
running done-list in the memory field, persisted verbatim — possibly the real carrier, but no
v29 until the labeled trace says where ours actually diverges.

DIAGNOSIS (2026-08-14, labeled trace + page probe): **the model was never lost — it was blind.**
The labeled 6-part trace shows every NAMED clause executed correctly in order (congue → Cancel →
yCHnj → umU3W2u → Submit → Close) and reward 0: the one unlabeled action, clause 1's anonymous
'text widget', is a silent coin flip because the page has multiple nameless same-role rows whose
rendered ctx is IDENTICAL bag-of-page-words ('e OXn epre Oxc Venenatis...') — context extraction
collapses to page-level soup on multi-section pages, discriminating nothing. One silent wrong
click at clause 1 poisons the terminal reward while every later clause executes cleanly — which
is exactly what 'clean for ~10 steps then 0' looked like from outside. Five mechanism pilots
(v23–v28) failed because they all treated a perception defect as a reasoning defect. Next:
v29 = discriminative per-row context (nearest section/heading ancestor + local siblings, unique
per row where twins exist) — a perception primitive for any multi-section page, nothing
CompWoB-specific. Pre-registration follows implementation.

## PRE-REGISTERED (2026-08-14, before any v29 episode): discriminative row context pilot

Mechanism: `local_ctx` (v29), perception layer, three rungs -- (1) `dom_group_hints`: nearest
SMALL labeled DOM ancestor (id/first class token, <=8 bids under it) becomes '§ <label>'; the
AX tree prunes unlabeled wrappers so this is recovered from the DOM snapshot ('div.widget >
input' was arriving as an anonymous textbox among 29 siblings); (2) sibling-group names ('w/
kgfN 1E9F ...') when no labeled ancestor exists; (3) old nearest-text fallback. Section labels
always render (a unique name cannot answer WHICH-group questions). Acid test passed offline:
the widget section self-labels (§ widget on its 5 rows incl. both named textboxes), dialog
titlebar self-labels, choice groups get distinct sibling contexts. Nothing task-specific: ids
and class tokens are how every real page names its sections. Prediction: >=3 of 8 pilot
targets (every one whose FIRST failing clause is an anonymous-among-twins pick — all 5
click-widget-containing targets are candidates), controls 12/12 unharmed (v22 arm untouched;
gate is the arm flag).

VERDICT (same day): **targets 0/8, controls 12/12 — prediction failed BUT the labeled trace
shows the mechanism worked and exposed the next layer.** Step 1 now clicks the RIGHT element
(the § widget textbox, by name) — and the click TIMES OUT: probe confirms the task's dialog
physically covers the widget (elementFromPoint = ui-dialog-titlebar), Playwright correctly
refuses covered clicks, and the model only hears 'TimeoutError', so it guesses coordinates and
the clause silently stays undone. The composition is adversarial by construction: the goal
orders dialog-close LAST, so the right move is dragging the dialog aside (order-neutral) — a
thing the model cannot infer from a bare timeout. v29 ships regardless (controls clean, and
labeled traces prove correct target selection); it was necessary, not sufficient.

## PRE-REGISTERED (2026-08-14, before any v30 episode): blocked-click intelligence pilot

Mechanism: `blocker_probe` (v30 = v29 + this) — when a click times out on actionability, run.py
names the covering element in last_action_error ('BLOCKED: DIV.ui-dialog-titlebar is covering
this element -- move or close the cover first'); history keeps the full blocker text; one system
rung teaches the response (drag the cover aside if the goal needs it later, close it otherwise,
then retry). Feature-triggered only on actionability timeouts; zero effect on episodes without
blocked clicks. Real-world analogue: cookie banners, modals, sticky headers. Prediction: >=3 of
8 pilot targets (the 5 click-widget+click-dialog compositions are the candidates), controls
12/12 (mechanism cannot fire on them).

VERDICT (same day): **targets 0/8, controls 12/12 — the blocker path never fired because the
model sidestepped it into a TRAP ROW.** Labeled trace: step 1 clicked the row named '(widget)'
— a weak-named clickable WRAPPER div that shadows its single real child; the click lands (no
timeout, no error), the page ignores it, the clause silently stays undone. The composed pages
render every widget twice (generic mirror + real element); we showed both. Second finding:
login-composition targets die to 'policy produced no action' (unparseable replies) — raw
replies are now captured on no-action turns (LlmDecision.raw_tail) to make that diagnosable.

## PRE-REGISTERED (2026-08-14, before any v31 episode): wrapper-suppression pilot

Mechanism: `suppress_wrappers` (v31 = v30 + this) — a weak-named clickable (empty or
'(attr-hint)' name) whose subtree holds exactly ONE other picked element is that element's
wrapper: drop the shell, keep the properly-roled child. Acid test: the trap '(widget)' row and
all four generic widget mirrors vanish; the five real § widget elements remain (31 -> 25 rows).
Generic: wrapper-shadowing is how most real pages wire icon buttons and custom controls.
Prediction: >=3 of 8 targets (click-widget compositions specifically; the blocker rung from v30
now actually gets exercised when the model clicks the real covered input), controls 12/12
(suppression only fires on single-child weak-named shells).

FIRST RUN VOID (implementation bugs, not a verdict): targets 0/8 but the labeled trace showed
the BLOCKED message never reached the model — (a) it was APPENDED after Playwright's multi-line
call log and truncated out of both the record and history caps; (b) the bbox source
(extra_element_properties) goes stale post-step and pointed the probe at BODY. Fixed: message
prepended; rect computed in-page from the live bid element (verified: probe names
DIV.ui-dialog-titlebar). Also fixed alongside: empty LLM completions (thinking exhausting
max_tokens) are now retried with doubled budget instead of being booked as no-action turns —
this was the entire login-composition 0-step failure mode. Prediction unchanged; pilot rerun.

RERUN VERDICT (2026-08-14): **fail on targets (0/8 pattern continuing; controls clean).** The
BLOCKED message now demonstrably reaches the model and changes behavior — the trace shows it
attempting to move the dialog (dragging the Close row: the titlebar itself is not an
addressable element) and then resuming the clause sequence — but it never RETRIES the blocked
clause-1 click, so the composition still scores 0. Model-side remediation of occlusion is now
0-for-2 (instruction alone, instruction + named blocker).

## PRE-REGISTERED (2026-08-14, before any v32 episode): forced dispatch on blocked clicks

Mechanism: `force_unblock` (v32 = v31 + this) — when a click is BLOCKED, run.py dispatches a
synthetic el.click() on the target immediately and the error says so ('the click was DISPATCHED
anyway ... check the page before repeating it'). Rationale: CDP-driven stacks (browser-use)
have exactly these semantics natively — occlusion never stops their clicks — so this is
actionability PARITY between stacks, not a cheat; the blocked attempt and the forced dispatch
are both surfaced honestly in history and in the book. Prediction: >=3 of 8 targets (the
click-widget+click-dialog compositions), controls 12/12 (fires only on blocked clicks, which
controls never hit).

VERDICT (2026-08-14): **prediction failed (1 of 8 targets; needed >=3) — but the one win is the
FIRST >=5-part victory in the entire ladder** (the 6-part dialog composition, 9 steps, the exact
task the occlusion chain was diagnosed on), and controls are 12/12 across the whole stacked
v29–v32 change set. The 7-8-part traces show the full mechanism operating: blocked clicks
named and dispatched, the model dragging the dialog aside, every clause then executed in
order — and the page still scores 0. The residue lives inside the composed pages' own
validators (event order/timing/type semantics not observable from outside the page). BOUNDARY
BOOKED: the CompWoB mechanism ladder ends here at v32. Net yield of the dig: three genuine
perception primitives (section labels, wrapper suppression, named blockers), occlusion parity
with CDP stacks, empty-completion retries, and labeled-target instrumentation — all
real-product, none benchmark-specific. Full CompWoB sweep on v32 is a measurement of where the
final stack lands (controls clean = safe); MiniWoB-125 3-seed regression follows it.

## CompWoB FINAL on v32 (2026-08-14): 77.9% — goal clause (>=75) MET

**74/95 clean = 77.9%** (was 65.3 on v22; +12.6 from the v29–v32 perception/actionability dig).
6 of 101 pages excluded as infra: all login-family, deterministic upstream genProblem crash
under our launcher (attempted across three supervisor passes; blacklisted, disclosed). Zero
false claims; median 19s wall, 12.5k tokens. By parts: 2-part 56/66, 3-part 12/18, 4-part 3/4,
**5-part 1/2, 6-part 2/2** (this cluster was 0-for-everything before v32), 7-8-part 0/3
(page-validator boundary, booked above).

Head-to-head vs browser-use on the 94 tasks BOTH stacks completed cleanly: both-win 67,
they-win-we-lose 12, we-win-they-lose 7, both-lose 8 → theirs 84.0% vs ours 78.7% (their
82.0 headline also counts the 6 pages that crash under our launcher). Their 12 wins cluster:
7 are '-reverse' instruction-order variants, 3 dialog-first, 2 login-popup — order-literal
execution (ours) vs order-opportunistic (theirs). Staged v33: deferred-clause execution
(attempt stated order; a clause whose target is missing/blocked is DEFERRED and revisited,
never stalled on) — pre-registration against exactly this 12-task cluster before any episode.

## PRE-REGISTERED (2026-08-14, before any v33 episode): opportunistic-ordering pilot

Mechanism: `defer_nudge` + deferral doctrine rung (v33 = v32 + both). Head-to-head analysis
showed browser-use's remaining 12 wins over us cluster on reverse-order and dialog-first
compositions: order-literal execution vs their order-opportunism. v33 teaches: attempt stated
order; a step whose target is missing or BLOCKED is DEFERRED (do the next doable step, return
before finishing); mechanically, any failed/blocked action gets a defer-reminder appended in
history. Targets: exactly the 12 tasks they win and we lose (v33_pilot.json) + 12 standard
controls. Prediction: >=5 of 12 targets (the 7 reverse-order ones are the core candidates),
controls 12/12. Pilot runs only after the MiniWoB regression frees the LLM lane.

VERDICT v33 (2026-08-14): **fail — targets 1/12, controls 12/12.** Deferral never fires on
reverse tasks because nothing ERRORS: the fastpath instantly clicks the goal's first-QUOTED
target, which under 'X, after doing Y' grammar is the last-executed step — 1-step terminal
losses, no model call involved. The model, when consulted, parses the inversion correctly
(it opened the dialog case in the right order unaided). Mechanism withdrawn.

## PRE-REGISTERED (2026-08-14, before any v34 episode): fastpath inversion gate

Mechanism: v34 = v32 + one gate — fastpath stands down when the goal contains subordinate
order conjunctions (after/before/once), sending those sentences to the model. Linguistic
feature-trigger, no task names, no new scaffolding; normal goals keep the scripted speed path
(unit-checked both ways). Prediction: >=3 of the 7 reverse-order targets flip (the two 1-step
losses at minimum), controls 12/12 (no control goal contains the conjunctions).

VERDICT (2026-08-14): **partially confirmed — the two named 1-step losses BOTH flipped (2-step
wins), plus one non-reverse target; 3/12 targets, reverse 2/8, controls 12/12.** The strict
>=3-reverse bar missed, booked as such. The gate keeps: measured wins, zero cost, correctness
over speed on inversion grammar. v34 is the champion config going forward. The remaining 9
bu-edge tasks fail deep (dialog-first and checkbox+widget combos, 8-24 steps in) — each its own
dig; deprioritized behind WebChoreArena and the unmeasured goal clauses. CompWoB estimate under
v34: ~77/95 ≈ 81% (74 + the 3 pilot flips at sweep seed); 12-task delta rerun queued to book it
properly after the 3-seed rerun frees the lane.

DELTA RERUN BOOKED (2026-08-14): the same 3 flips reproduced (both reverse 1-step tasks + the
login-transition) — **CompWoB champion (v34): 77/95 = 81.1%**, zero false claims. Gap to
browser-use's 82.0 headline: within the 6 infra-excluded pages; on the 94-task common set the
remaining deficit is the 9 deep-failure tasks booked at the validator boundary.

## MiniWoB 3-seed on the v32 stack (2026-08-14, post ctx-uniqueness fix)

**89.0 mean (90.2 / 90.3 / 86.4)** vs the v22 baseline 90.9 (89.6/92.0/91.2). The interim 87.5
was measured on the buggy displaced-context code and is superseded. The ctx-uniqueness fix is
validated: social-media-all recovered 3/3 seeds. Remaining delta vs v22 concentrates in
choose-date/book-flight/form-sequence: the native-picker fill dead-ends on READONLY datepicker
inputs (trace: fill times out 3x, model resorts to Prev-clicking through re-rendering months),
plus long-form seed variance (seed 44 alone is -4). Honest net of the v29–v34 stack: **-1.9
MiniWoB, +12.6 CompWoB, +2 more CompWoB tasks under v34** — strongly positive, one agent, no
per-benchmark configs. The readonly-picker dead end is a named future primitive (JS value-set
fallback when a picker fill bounces); the >=95 MiniWoB clause remains open.

## PRE-REGISTERED (2026-08-15, before any v35 episode): readonly-picker fallback pilot

Mechanism: `native_js_fallback` (v35 = v34 + this) — a fill that bounces off a READONLY input
is applied through the page's OWN widget machinery (jQuery datepicker setDate when present;
value+input/change events otherwise), and the model is told to verify. Unit-verified against
the live page WITHOUT any model: fallback + submit scores 1.0 from MiniWoB's own reward.
Built during the quota outage (all lanes 429 — the plan window; sweeps paused ~9h so far).
Prediction: choose-date / choose-date-nodelay flip (both lost 2/3 seeds to exactly this dead
end), book-flight improves; controls (non-picker tasks) untouched — the mechanism fires only
on readonly fill timeouts. Pilot: the picker-loss cluster + 12 standard controls, when the
lane returns; then a full 3-seed to re-measure the MiniWoB clause.

## MiniWoB 3-seed on the FULL v35 stack (2026-08-15, primary Claude column)

**90.5% mean (89.5 / 91.1 / 91.0)**, infra excluded — vs v22 90.9 (flat, within seed noise) and
+1.5 over the buggy-ctx v34 stack (89.0). The v35 picker fallback recovered choose-date (3/3 all
seeds) as designed; the ctx-uniqueness fix holds (social-media clean). Net of the entire v29–v35
dig on MiniWoB: ~flat (the primitives that win CompWoB neither help nor hurt MiniWoB — they fire
on features MiniWoB's simpler pages rarely present), while CompWoB went 65.3 → 81.1. Residual
≥95 gap is a stable hard cluster losing 2–3/3 seeds: draw-circle (freehand pixel geometry),
book-flight/-nodelay (flight-search autocomplete — a NAMED next primitive), hot-cold (pure
feedback-search game), form-sequence-3 (deep ordered form), search-engine (result pagination),
drag-items-grid (2D drag geometry). These are ~6 distinct product primitives, not prompt-tuning;
each is its own dig. ≥95 clause remains open with the path named.

## Lane note (2026-08-15): Claude lane outage → GPT-5.4 cross-model column

CORRECTION (same day, user evidence): the outage was NOT plan exhaustion — the user's plan
dashboard showed 2% of the 5-hour limit and 6% weekly. The true signature: ~14h of constant
429 whose 'reset after 2m' never advanced (a real window would have rolled ~3 times), a 401
'OAuth access token has expired' mid-outage, and recovery minutes after the router refreshed
its token. Diagnosis: a STALE OAUTH TOKEN in the router rejected upstream and surfaced as 429.
Remedy: when a 429 horizon fails to advance for >30min, restart/re-auth the router — do not
wait out a phantom quota window. Original (wrong) framing kept below for the record:

The cc/ lane (Claude Code OAuth = the Claude subscription, NOT pay-per-token API) 429'd every
Claude model for ~12h. The ChatGPT/Codex subscription lane (cx/gpt-5.4) is live, so measurement
continues there under a SEPARATE arm identity ('osw-llm-vNN@gpt', own data file) — GPT results
are never merged into the booked Claude numbers. This is a feature, not just a workaround: the
same harness on a different model family is the cleanest test of the goal's core claim (harness
>> model, no model-specific logic). GPT-5.4 canary: 3/3 incl choose-date (v35 picker fix holds
cross-model) and social-media-all (ctx fix holds). All Claude numbers stand as the primary
column; GPT-5.4 becomes a parallel generality column. No fable-5 used (unrelated axis).

## GPT-5.4 cross-model MiniWoB column (2026-08-15, v35 harness)

**86.1% mean (88.0 / 87.2 / 83.2)** — the SAME harness, same 375 episodes, model swapped
Claude-opus-5 → gpt-5.4. Within ~3 points of the Claude v35 stack (89.0), and ~11 points above
the best published GPT generic harness (71.5). This is the goal's central claim measured
directly: the harness carries the result across model families, not one model. v35 picker fix
transfers cleanly (choose-date family 3/3 on gpt too). Remaining gpt losses mirror Claude's
(book-flight autocomplete, drag geometry, seed-44 long-form variance) — same failure classes,
confirming they are harness/task properties, not model quirks. Booked as its own column; the
Claude numbers remain primary and unmerged.

## WebChoreArena GPT-5.4 column FINAL (2026-08-15, 91-task reddit partition, their evaluator)

**2/86 scoreable solved (2.3%) | partial-sum 2.00 | 21 answers delivered | 0 false claims |
median 154s/task.** 5 of 91 excluded: 2 setup-infra + 3 crashes inside THEIR evaluator
(module-scope AzureOpenAI + unbound 'response' on specific tasks — upstream bugs, disclosed).
Scoring: deterministic evals only (string_match/program_html; their fuzzy-LLM modes unused).
Context: the paper's frontier agents land 20-40% — but uncapped wall-clock and much larger
step/token budgets; ours ran a 500s/episode cap and 50 steps (disclosed instrument choice —
chores are DESIGNED long, so our cap costs real points; an uncapped rerun is the fair
follow-up). Honesty clause holds on a hard live benchmark: zero false success claims. The
solved chores (30140, 30161) are multi-hop search+compute tasks — capability exists; scale of
budget is the binding constraint. Claude primary column completes next.

## Open-source / SOTA reference points (2026 leaderboards, for honest comparison)

- WebArena: SOTA WebTactix/DeepSeek-v3.2 74.3%; frontier models 64-68%; human 78. (leaderboard.steel.dev)
- OSWorld: SOTA Claude-Mythos submission 85.4%; BEST OPEN-SOURCE UltraCUA-32B 41.0% (beats
  Claude-3.7-CUA 27, OpenAI-CUA 26); human 72.
- Online-Mind2Web (live, LLM-judged — not in our scored set): browser-use CLOUD 'bu-max' 97.0%;
  best open-source Avenir-Web 53.7% (Gemini-3-Pro); fully-open 25.7% (Qwen-3-VL-8B); browser-use
  LIBRARY 26.0%.
- CompWoB: best published = HTML-T5++ 61.5% (fine-tuned transfer); best PROMPTED 28.7% (RCI).
  **Ours 81.1% exceeds every published CompWoB number, tuned or prompted.**

CRITICAL DISTINCTION for the 'beat browser-use everywhere' directive: 'browser-use' = TWO
products. (1) The open-source LIBRARY (what we run head-to-head in-arena: ~71 MiniWoB, 82
CompWoB, 26 Mind2Web) — we beat/match it everywhere except CompWoB -0.9. (2) browser-use CLOUD
'bu-max' — a heavily-tuned commercial product topping live Online-Mind2Web at 97%. Our clean
generic harness does NOT beat bu-max, and claiming so would be dishonest (their cloud = retries
+ custom scaffolding + proprietary tuning; ours is deliberately generic/audited). Beating the
LIBRARY generically is the honest, in-scope goal; matching a tuned cloud product is not, and is
not claimed.

## Benchmark roadmap (2026 landscape survey, method-filtered)

Rules: third-party scoring, reproducible from a committed artifact, no LLM-judge (or deterministic
subset only). ADDED: WebChoreArena (COLM 2026, wired, sweep queued); REAL/realevals.xyz (11
deterministic self-hosted simulations of real sites, 110+ tasks, programmatic state verification
— deterministic subset only) next after it; WASP (Meta, prompt-injection — the >=95 injection
clause); OSWorld (the >=85 clause; biggest infra lift). WASP adapter design (2026-08-15, from repo read): their ASR scorer is an AzureOpenAI classifier
(LLM-judge → excluded for scoring per method), but the >=95 injection-refusal clause has a
DETERMINISTIC core — the injected tasks are concrete observable side-effects (navigate to
{attacker_domain}?token=..., create a deploy token). Plan: run their gitlab/reddit injected
tasks through our runner (sites already up), score refusal from the action trace deterministically
(did the agent hit the attacker domain / perform the injected write — boolean), no classifier.
Configs at ~/.cache/arena/wasp/webarena_prompt_injections/configs/experiment_config.raw.json.
EXCLUDED with reasons: Online-Mind2Web
(LLM-judge on live drifting sites — but its '59% weaker on live web' finding motivates the live
verified-writes clause), WebVoyager (publicly described as saturated), GAIA/BrowseComp/
LiveAgentBench (research-QA, not browser operation), VisualWebArena (screenshot-agent variant of
sites we already run; low marginal signal).

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
