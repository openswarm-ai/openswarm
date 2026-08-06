# Handoff: browser v3, state as of 2026-08-06

Branch `eric/browser-merged`, 45 commits past `origin/eric/dev`, pushed. Browser suite 707 passing, tsc 0,
linter no new violations, tree clean. The goal and the harness are described in `README.md`.

**Six of nine criteria pass. Three are open, and none of them is open because the fix is unknown.**

## Scorecard

| # | criterion | target | before | now | |
| --- | --- | --- | --- | --- | --- |
| 1 | composer reach | >=90% | 57% | **93%** (28/30) | PASS |
| 2 | verified writes | >=95% | no honest data | LinkedIn proven end to end; N too small | OPEN |
| 3 | false success | 0 | unknown | **0** in every live round | PASS |
| 4 | median write | <=12s | ~21s | **1.99s** (p95 12.2s) | PASS |
| 5 | cold start tier-0/1 | <=3s | ~16s | **0.13s** | PASS |
| 6 | other_ms | -50% | none | **-70%** (417 -> 126ms) | PASS |
| 7 | infra flake | <=1% | 60% | 34 runs, 0 failures; sample too small | OPEN |
| 8 | holdout | >=80%, <=10pt | untested | **87%**, 6pt gap | PASS |
| 9 | learned path | remove or >=50% | 0/55 | **recording 4/4 = 100%**; replays 0 of 2 | OPEN |

Per-site reach at N=5 (criterion 1): x 5/5, linkedin 5/5, reddit 5/5, **instagram 5/5** (was 1/10),
youtube 4/5, **twitch 4/5** (was 0/3). gmail, tiktok and substack are excluded, see Exclusions.

Timing at n=28 successful runs (criterion 4/6): wall median 1988ms / p95 12180ms; browser tools
median 1621ms; **`other_ms` median 126ms, down from 417ms**. Wall fell too, so nothing moved from one
bucket into another.

## The finding that matters most

**Several "product failures" were the measuring instrument.** This is the single most useful thing to
carry forward, because it recurred six times in one session and each instance cost hours chasing a
bug that did not exist.

The worst case: criterion 2 failed on LinkedIn for days. **LinkedIn was never broken.** The canary
proved a write landed by grepping the backend log for the marker string, and the backend does not log
page text. A grep for every canary marker ever generated, across every backend log on the machine,
returns zero lines. The audit could only ever answer "could not look", and that was being read as a
product failure. `probe_evidence.py` settled it: the session API carries the model's *answer* and
never the tool results, so auditing it is asking the same model whose claim is under audit.

Every dead grep found, and what each did:

| where | needle | occurrences in source |
| --- | --- | --- |
| canary `delivered` | `DELIVERY CONFIRMED` | 0 |
| canary `saw_page` | two `[browser-action] X` strings | 0 |
| canary receipt | only the fast-lane string; 2 of 3 producers missed | 1 of 3 |
| skillstats `replay_full` | `replay(ed\|ing) N steps` | 0 |
| bench `infra_browser` | `card is unavailable` | 0 |
| `stack.sh status` | `pgrep -fc` (no such flag on macOS) | printed 0 over a live stack |

`verify_markers.py` now checks all 32 harness literals against the source that prints them: 32/32
present. **Run it before trusting any number.**

## What is open, why, and exactly what to do

### Criterion 2, verified writes

The instrument was rebuilt (`950755af`) and the first result was linkedin **PASS**: posted,
receipt-verified, deleted, verified gone. That is the first clean end-to-end LinkedIn round this
project has recorded. One site is not >=95% across sites, so the criterion is not met.

Blocked on nothing technical. Two things to do first:

1. **Verify reddit's Title field name.** `af68dcd0` prefers the textbox whose accessible name
   contains the field word the task used, and requires *exactly one* match. The unit tests use an
   assumed listing (`[21]<textbox "Title" />`) that has never been confirmed against the live page;
   the backend only logs `textboxes=3`. If reddit's title input is named something else, the fix
   silently does nothing. reddit is 1 of the 3 sites in this denominator.
2. Then `ROUNDS=7 c2_rounds.sh` and `c2_tally.py`.

### Criterion 7, infrastructure flake

Last clean sample: **34 of 108 runs, 0 infra failures, 0 backend restarts.** Encouraging but partial.
An earlier 5.4% reading was contaminated: a second OpenSwarm checkout was up on :8324 and the shared
9router on :20128 was being evicted.

Needs a box with nothing on :8324, then `N=12 c7_run.sh` for the full 108.

### Criterion 9, learned fast path

The starting baseline, over 427 gate decisions on **dry** sweeps: **95 eligible, 0 recorded, 0
replays**, with one refusal reason (`host empty or no robust steps`). Read on its own that number is
misleading, see "measure this on a LIVE run" below; but the refusal reason was a real bug.

The gate was never the problem. Every eligible run died inside `record_skill`: `distill_steps` reads
`clicked_name`, and `browser_send_script.py` wrote the element name into `result_summary` prose only.
An unnameable click truncates the distillation, truncation drops the typing steps, and the
navigation-only remainder is correctly refused. Fixed in `438a96eb`, proven directly:

```
OLD shape (no clicked_name) -> []
NEW shape -> ['BrowserNavigate', 'BrowserClickByName', 'BrowserClickByName']
```

Safety held rather than added: a `BrowserClickIndex` distills to a name-only `BrowserClickByName`, so
the payload never enters the skill, and the send click's tool name matches no distill branch, so a
replay cannot re-fire a send.

**Recording is PROVEN live, at 100%.** On the live canary rounds (`r4`): 14 runs reached the gate,
**4 were eligible, 4 recorded, 0 refused.** Two skills persist on disk with exactly the shape the
unit test predicts, both timestamped after the fix:

```
x.com            BrowserNavigate(https://x.com/compose/post)
                 BrowserClickByName(textbox "Post text")
www.linkedin.com BrowserNavigate(https://www.linkedin.com/feed/?shareActive=true)
                 BrowserClickByName(textbox "Text editor for creating content")
```

**Measure this on a LIVE run, never a dry one.** Recording is gated on `delivery_verified`, which a
dry run can never produce, so a dry sweep correctly records nothing. Reading a dry log as a verdict
is how this was first misreported as "0/95, the fix did not fire". `skillstats.py` now prints a note
when it sees that shape. (It also had two counting bugs of its own, fixed: it counted the
`slots unfillable` FAILURE line under a label that read "skill matched", and it never surfaced
quarantines.)

**What still fails is REPLAY: 0 of 2.**

1. **x.com truncates to a bare navigate.** `is_replay_boundary` flags the composer click as
   irreversible because the accessible name `Post text` contains "post". It is a textbox, and
   focusing a textbox is reversible, but the guard matches on the name only. The prefix therefore
   replays a single navigate, which prestage already does in 0.13s.
2. **linkedin quarantines.** `replay step failed (BrowserClickByName: No element matching
   role="textbox" name="Text editor for creating content")`. LinkedIn's composer is lazily mounted
   and does not exist at navigate time; the recorded skill never learned the opener click that
   reveals it. Quarantine is correct behaviour here, not a bug.

**So criterion 9 clears the >=50% recording bar and fails the "successful replays and measured
benefit" half.** Before investing in either replay fix, answer the question that decides it: prestage
already reaches a tier-0/1 composer in **0.13s**, so what is a replay actually worth? If the answer is
"nothing", removal is the honest path and the criterion explicitly allows it. The two
`browser-memory` endpoints have no frontend caller (grep of `frontend/src` and `electron/` returns
nothing), so removal is not user-visible.

## Product bugs found by the fixed instrument

- **reddit: the task named a field and nobody read it** (`af68dcd0`). "create a text post whose title
  is exactly X" filled the body, Title stayed empty, and reddit's submit stayed DISABLED on every
  attempt. A field word from the user's own sentence now beats the compose-shape guess. 6 tests,
  including that no-hint behaviour is byte-identical.
- **disqus: a stalled top document denied its own child frames** (`7ba99ba4`). The still-loading
  retry rethrew on a second failure, killing `find_composer` before the child-frame search ran. An
  ad-heavy page keeps the top document loading while the composer, in an embedded iframe with its own
  load state, is perfectly readable.

## Known false negatives, filed not fixed

Both under-claim rather than over-claim, so neither violates criterion 3, but both read as drift on
every live round.

- **A torn-down browser card wedges, and `navigate` lies about it.** Reproduced 4x: the reply is
  `{"text":"Navigated to https://x.com/home","url":"https://x.com/home"}` in ~80ms while the webview
  never leaves reddit. Anything trusting that reply reads the wrong page and answers confidently
  about it. The audit now re-reads `location.href` and requires a host match.
- **Delete reports failure on deletions that provably worked.** X, 2 for 2: "the deletion was never
  confirmed", and an independent read shows the post gone both times. LinkedIn showed the same shape.

## Exclusions (predefined, never quietly dropped)

gmail, substack and tiktok are signed out; tiktok is additionally captcha-walled. That is 14 of 45
rows on the known suite. Each exclusion is judged on the page's own evidence, never on the product's
claim. Solving a bot-detection challenge is off-limits, so a captcha-walled page is one this system
is *choosing* not to reach, and scoring it against reach would charge us for a rule we intend to keep.

## Account hygiene

Every marker written to a real account during this work was cleaned up and independently verified
gone: X profile scan shows 0 markers with the newest genuine post predating the tests, and the
LinkedIn post permalink returns nav chrome with no content.

Personal handles are **not** committed. Both live sites read their account from the environment
(`OSW_CANARY_X_HANDLE`, `OSW_CANARY_REDDIT_HANDLE`), and an unset handle makes the round refuse
loudly rather than audit a malformed URL.

## Environment notes

- The stack is backend :8326, webpack :3026, Electron on its own `--user-data-dir`. It never touches
  :8324 or :3000, which belong to whatever else is on the machine.
- The backend was SIGTERMed three times mid-measurement, always cleanly, always with nothing in its
  log. Cause unknown. `stack.sh` now supervises it and writes `[stack] BACKEND RESTARTED` into the log
  the harness slices, so `bench.py`'s `infra_backend` bucket can exclude any trial spanning a restart
  instead of scoring it as a product failure.
- `stack.sh down` once matched `pkill -f "uvicorn backend.main"`, which is exactly what the other
  checkout runs, and it executed while that checkout was live. It is now scoped to this stack's own
  ports and profile and cannot match a process it did not start.

## Next executable steps, in order

1. `verify_markers.py` (32/32 expected).
2. Confirm reddit's Title field name against the live page.
3. Decide criterion 9: is a replay worth anything against a 0.13s prestage? If not, remove.
4. `N=12 c7_run.sh` on a box with nothing on :8324. Gives criteria 1, 4, 5, 6, 7.
5. `skillstats.py` on a LIVE round's log (not the dry sweep) for criterion 9.
6. `ROUNDS=7 c2_rounds.sh` then `c2_tally.py`. Gives criterion 2.
7. `N=2 c8_run.sh` to re-check criterion 8 after the disqus fix.
