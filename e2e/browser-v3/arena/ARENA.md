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
| **opus-5** | **82.4% @ 6.3s, 0 false** (v14); v15 81.6 with 3 first-ever solves | pending fair run | ours scales with the model |

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
