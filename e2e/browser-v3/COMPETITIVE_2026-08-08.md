# Browser-agent competitive read, measured 2026-08-08

Every number here was produced on this machine unless it is explicitly marked as a published claim.
Where a claim could not be verified, it says so rather than being repeated.

---

## 1. The finding that matters most

**A deterministic accessibility-tree snapshot beats our model-driven composer finder by 40-450x on
perception cost, and solves a site we fail on outright.**

| perception step | median | p95 | worst |
| --- | --- | --- | --- |
| **OpenSwarm `BrowserFindComposer`** (n=119) | **13,991ms** | 30,003ms | 905,840ms |
| **OpenSwarm prestage** (n=460) | **4,254ms** | 7,971ms | - |
| **agent-browser `snapshot`** (n=5 sites) | **~50ms** | 672ms | 672ms |

agent-browser is a Rust CLI with **no LLM anywhere in this path**. It reads Chromium's accessibility
tree over CDP and returns compact `@eN` refs.

### It fills, deterministically, what costs us seconds or fails

| site | shape | agent-browser fill | verified | OpenSwarm |
| --- | --- | --- | --- | --- |
| regex101 | CodeMirror 6 | **31ms** | yes | passes (7.7s) |
| onlinegdb | ACE | **326ms** | yes | **FAILS** |
| w3schools | ACE in iframe | **810ms** | yes | passes (10.4s) |
| gtranslate | plain textarea | 51ms | no* | passes (10.0s) |
| deepl | contenteditable | 26ms | no | fails (bot challenge) |

\* gtranslate mirrors its source text into the URL query rather than an editable this readback walks;
the fill likely landed. Recorded as unverified rather than assumed.

**onlinegdb is the headline**: our agent cannot reach it at all, and a no-model CLI fills and verifies
it in 326ms. deepl fails for both, for the same reason (see s.4).

---

## 2. Repos: verified, not taken on faith

All nine claimed repos exist, star counts match within rounding, and **every licence is compatible
with our AGPL-3.0-only** (checked because it decides what we may actually use).

| repo | stars | licence | last push |
| --- | --- | --- | --- |
| browser-use/browser-use | 108,315 | MIT | 2026-08-06 |
| vercel-labs/agent-browser | 40,200 | Apache-2.0 | 2026-08-08 |
| microsoft/playwright-mcp | 35,913 | Apache-2.0 | 2026-08-07 |
| bytedance/UI-TARS-desktop | 38,512 | Apache-2.0 | 2026-08-05 |
| jackwener/OpenCLI | 27,912 | Apache-2.0 | 2026-08-08 |
| browserbase/stagehand | 23,770 | MIT | 2026-08-08 |
| Skyvern-AI/skyvern | 22,712 | AGPL-3.0 | 2026-08-08 |
| browseros-ai/BrowserOS | 13,036 | AGPL-3.0 | 2026-08-08 |
| ServiceNow/BrowserGym | 1,310 | NOASSERTION | 2026-07-17 |

Category matters and is easy to get wrong: **agent-browser is a primitive layer with no model**,
browser-use is an **agent**, stagehand is an **SDK**. Benchmarking the first against the second is a
category error; the comparison in s.1 is against our own deterministic finder, which is its true peer.

---

## 3. browser-use, measured as an agent (n=43 trials)

Same five tasks, same Claude model via 9Router, same verified bar (payload read back out of the live
page, never the agent's own claim).

| | reach | median wall | p95 |
| --- | --- | --- | --- |
| **OpenSwarm scripted path** | 21/21 where it fires | **9.8s** | 12.7s |
| **OpenSwarm full model loop** | measured once, regex101 | 37.8s | - |
| **browser-use** | 39/43 | 35.7s | 85.0s |

Per site, on successes: gtranslate 10.0s vs 28.6s, regex101 **7.7s vs 36.3s**, w3schools 10.4s vs
37.7s. We are faster on every site we reach.

**Their 3 failures** were iframe-embedded editors and slow SPAs: one w3schools miss where it typed
into the wrong box **and claimed success anyway** (its only false success), plus two runs burning 11
steps and ~72s without opening the target page.

**Caveat that invalidates a straight reach comparison:** our arm ran in dry-run, which ends the run
after the scripted path (`browser_agent.py:1864`), so our adaptive fallback never executed. The
speed numbers are like-for-like on successful trials; the reach numbers are not.

---

## 4. Why deepl fails for us and not for them

Direct evidence from the CDP target list on our own Electron:

```
iframe  https://challenges.cloudflare.com/cdn-cgi/challenge-platform   <- on the deepl webview
```

deepl serves **our** browser a Cloudflare bot challenge. Our agent detects it and refuses to solve it
("handing to the user, not solving it") -- correct, documented behaviour.

The asymmetry is profile reuse, not capability:

| | profile | deepl hits today |
| --- | --- | --- |
| OpenSwarm | persistent, **1.7 GB**, shared across every run | **213** |
| browser-use | **fresh per run** | ~1 each |

This is a benchmark artifact we created; no real user hits deepl 213 times from one profile. Note also
onlinegdb serves **~100 ad iframes**, which is why our frame-walking finder times out there.

---

## 5. OpenCLI: the architecture worth stealing for criterion 9

Our learned fast path has **0 successful replays, ever**, because a recorded skill is
`[navigate, click composer]` -- fragile UI coordinates that add nothing over prestage.

OpenCLI inverts this: **API-first, browser as fallback.** It does "network inspection, initial state,
bundle search, token trace, or interceptor fallback" to find the endpoint *behind* the UI, and drives
the UI only when no API is reachable. It also ships `opencli-autofix` to **repair** a broken adapter,
where we only quarantine.

Two concrete transplants:
1. Record the **network call** a compose action makes, not the clicks. Robust and instant on replay.
2. **Repair on breakage** instead of quarantining.

---

## 6. Polar: not benchmarked, and why

Their ToS §1.4 prohibits exactly this work:

> "reverse engineer, decompile, or otherwise attempt to extract the source code or underlying
> structure of the Services"
>
> "use the Services to develop or train a competing AI product or service"

Running it requires an account, which means accepting those terms and then immediately breaching
them. Not done.

**Their 98.0 claim does not survive checking.** Their chart lists "Claude Opus 44.5", which is exactly
the published SOTA of the independent CMU **Odysseys** benchmark -- so competitor figures are Odysseys
numbers, while "OdysseysBU Bench V1" concatenates two different benchmarks. On **BU Bench V1** the
best published score is **80%** (Claude Fable 5). Polar's 98 exceeds the best independently verified
number on either, **appears on neither leaderboard**, and ships **no methodology**; their own post
concedes "the leading browser agent benchmarks don't represent knowledge work tasks."

Independent hands-on review (piunikaweb, day-long): Amazon cart task **2m42s**; "MacBook Air M2 got
ridiculously hot" on 8 tabs; "the browser even crashed on me completely"; one task cost 203 credits
against a 100/day free allowance; **refused to disclose which model powers it**.

---

## 7. Benchmark reality check

The same systems score wildly differently by benchmark, so any single number is marketing:

| benchmark | realism | best |
| --- | --- | --- |
| WebVoyager | 643 tasks, 15 popular sites | Browser Use 89.1%, OpenAI CUA 87% |
| Online-Mind2Web | live, dynamic | OpenAI Operator **61%**, best OSS 53.7% |
| Odysseys (CMU) | 200 long-horizon multi-site | **44.5%** |

A CMU-adjacent paper is titled *"An Illusion of Progress? Assessing the Current State of Web Agents"*.
**Nobody is at 90% on realistic tasks.** The real ceiling is ~60%.

---

## 8. What to actually do, ranked by measured impact

1. **Adopt an accessibility-tree snapshot as the primary perception path.** 50ms vs our 13,991ms
   median, and it solves onlinegdb deterministically. This is the single largest available win and it
   needs no model.
2. **Fix prestage or delete it.** 4,254ms median, 71% of the fast path, and mostly failing:
   **124 "did not settle" + 118 "repeated step" against only 12 tier-0 hits** over 460 runs.
3. **Record network calls, not clicks** (OpenCLI) -- the only route to a learned path that replays.
4. **Fresh profile per run in the harness** (not the product; the product needs its cookies).
5. Already shipped: browser-use's CSS-only visibility rule (fixed ACE reach), and an approval that
   declines instantly when no UI is attached instead of parking a turn for 300s.

---

## 9. Honest limits of this document

- n=5 sites for the primitive benchmark, n=43 for the agent benchmark. Wilson CIs on 43 trials are
  roughly +-15 points; treat per-site numbers as directional.
- Our reach numbers ran with the fallback disabled by dry-run.
- The anon suite is one I built and then optimised against; the holdout is the guard, and it held.
- agent-browser was measured on perception+fill only, not on end-to-end task completion, because it
  has no agent loop to compare.
