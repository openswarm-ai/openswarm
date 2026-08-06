# Browser v3: the goal, where we are, and how to pick this up

This directory is the measurement harness for the browser write path, plus the evidence it has
produced so far. It exists because the browser agent's numbers were repeatedly wrong in ways that
looked like product bugs, and the only defence is an instrument you can re-run and audit.

**Read `HANDOFF.md` first if you are continuing this work.** It has the current scorecard, the three
open criteria, and the exact next commands.

## The goal

Nine exit criteria, all of which must hold at once:

| # | criterion | target | baseline |
| --- | --- | --- | --- |
| 1 | composer reach across the known suite | >=90% | 57% |
| 2 | verified writes across sites and repetitions | >=95% | no honest data |
| 3 | false success claims | **exactly 0** | unknown |
| 4 | median successful-write wall time | <=12s | ~21s |
| 5 | cold-start / prestage on a tier-0/1 hit | <=3s | ~16s |
| 6 | `other_ms` (the part our code owns) | -50% | unmeasured |
| 7 | infrastructure flake over >=100 site-runs | <=1% | 60% |
| 8 | frozen-holdout reach, and its gap to the known set | >=80%, <=10pt | untested |
| 9 | learned fast path: remove it, or >=50% recording with real replays | either | 0 of 55 |

Definitions that decide arguments later:

- **Reach** = navigated to the intended surface AND page-verified the correct editable composer.
  Filling *a* box is not reach; filling *the* box is.
- **Verified write** = the exact content was independently confirmed at the correct destination.
  Typed-only, unsubmitted, wrong-composer and unverified all count as failures.
- **False success** = reporting success without postcondition evidence. This is the hard gate.
- Unknowns, timeouts and silent failures are failures, never omissions.

## Layout

| file | what it does |
| --- | --- |
| `coverage.py` | **The one grader.** Site tasks, surface rules, exclusion logic. Never reimplement grading elsewhere; two graders drift and the harness starts lying in a new way. |
| `bench.py` | N trials per site, infra-vs-product bucketing, timing split, one artifact per trial. |
| `stack.sh` | Boots the isolated stack (backend :8326, webpack :3026, Electron on its own profile). `up dry`, `up live`, `down`, `status`. |
| `keep_renderer.sh` | Keeps an Electron renderer alive for the length of a sweep. |
| `c7_run.sh` | Known suite at N=12 = 108 site-runs. Criteria 1, 4, 5, 6, 7 in one pass. |
| `c8_run.sh` | The frozen holdout (criterion 8). |
| `c2_rounds.sh` | Live write rounds on the authorised accounts (criterion 2). |
| `c2_tally.py` | Aggregates the live rounds: verified writes, false successes, stranded markers. |
| `skillstats.py` | Criterion 9: recording rate, replay rate, and every refusal reason. |
| `verify_markers.py` | **Run this before trusting any number.** Checks all 32 literals the harness greps for against the source that prints them. |
| `rawbrowser.py` | Drives a browser card with no model in the loop. The audit channel, and the tool for cleaning up a stranded test post by hand. |
| `probe_evidence.py` | Dumps where a run's page text actually surfaces. Written to settle the question empirically instead of by assumption. |
| `HOLDOUT_FROZEN.md` | The holdout sites and the commit each was frozen at, before its first run. |
| `results/*.jsonl` | Raw per-trial rows. Every attempt, including failures and exclusions. |

## Running it

Everything needs the isolated stack and a quiet box.

```bash
e2e/browser-v3/stack.sh up dry          # dry: the backend refuses the irreversible click
N=12 e2e/browser-v3/c7_run.sh           # criteria 1, 4, 5, 6, 7
N=2  e2e/browser-v3/c8_run.sh           # criterion 8
e2e/browser-v3/skillstats.py runs/*.log # criterion 9
e2e/browser-v3/stack.sh down
```

Live write tests post to real accounts, so they need explicit handles and a live backend:

```bash
e2e/browser-v3/stack.sh up live
OSW_CANARY_X_HANDLE=<handle> OSW_CANARY_REDDIT_HANDLE=<handle> \
  ROUNDS=7 e2e/browser-v3/c2_rounds.sh
e2e/browser-v3/c2_tally.py runs/c2_r7.txt
```

`OSW_BENCH_DIR` relocates run output (logs plus a multi-gigabyte browser profile) off the repo disk.

## Rules this harness enforces on itself

These are not style preferences. Each one is a bug that already shipped a wrong number.

1. **Never grep for a string the code does not print.** Five separate dead greps were found in one
   session, each silently turning a metric into a constant. `verify_markers.py` exists to make that
   class impossible. Run it first.
2. **Absence is not evidence unless the read succeeded.** "The marker is not on the page" and "we
   never got a good look at the page" are different answers. Collapsing them into `False` falsely
   accused a working LinkedIn send of lying.
3. **Never grade the guard with the guard.** The audit reads the destination itself and consults no
   model. A receipt reporting on its own correctness proves nothing.
4. **Publish every attempt, exclusion and retry.** An excluded row is a claim that the product was
   not on trial, and that claim has to survive being read out loud.
5. **A site being signed out is an account state, not a coverage failure.** Exclusions are judged on
   the page's own evidence (a sign-in URL, a visible password field, a bot-detection challenge),
   never on the product's say-so.
6. **One backend per box.** A second OpenSwarm evicts the shared 9router and every timing becomes
   noise: the same sweep once scored 1/9 and 4/9 with zero code change. `stack.sh status` warns when
   :8324 is occupied, and `stack.sh down` is scoped so it can never kill another checkout's stack.

## Safety

- Live rounds write only to accounts the operator explicitly names by environment variable, and every
  post is deleted in the same run and re-verified gone.
- Markers are random and carry no removal words, which would otherwise trip the removal classifier.
- Dry mode is enforced by the backend (`OSW_SENDSCRIPT_DRYRUN=1`), never by a flag this harness sets
  and does not own. An earlier draft set it in the wrong process, which would have posted for real.
- The canary prints its marker on every row, not just failures. It is the only record of what was put
  on a real account, so a stranded post stays cleanable by hand.
