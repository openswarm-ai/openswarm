"""Criterion 9: does the learned fast path record, and does replaying it help?

Reads a backend log and reports the two rates the criterion names, plus the reason every refusal
gave. Every string below is grep-verified against backend/apps/agents/browser/, because the last
instrument that measured this layer looked for a line the code never prints.

    python3 skillstats.py <backend.log> [...]
"""

import re
import sys
from collections import Counter

# (label, regex). Anchored on the exact logger.info text in browser_skills.py / browser_agent.py.
PATTERNS = [
    ("gate_passed",   re.compile(r"record gate: honest=True informational=False removal=False unconfirmed_send=False")),
    ("gate_refused",  re.compile(r"record gate: (?!honest=True informational=False removal=False unconfirmed_send=False)")),
    ("recorded",      re.compile(r"\[browser-skills\] (learned|EDITED) \d+-step skill for (\S+)")),
    ("re_derived",    re.compile(r"re-derived identical \d+-step skill")),
    ("not_recorded",  re.compile(r"NOT recorded \(([^)]*)\)")),
    ("matched",       re.compile(r"\[browser-skills\] skill matched on (\S+)")),
    ("no_skill",      re.compile(r"no skill for host=")),
    ("replay_prefix",  re.compile(r"PREFIX replay: (\d+)/(\d+) steps on (\S+)")),
    ("replay_attempt", re.compile(r"REPLAY attempt: (\d+) steps on (\S+)")),
    ("replay_ok",      re.compile(r"REPLAY SUCCEEDED in (\d+)ms")),
    ("replay_failed",  re.compile(r"replay step failed \(")),
    ("not_replayed",   re.compile(r"skill on (\S+) not replayed: (.+?);")),
]


def main() -> int:
    text = ""
    for p in sys.argv[1:]:
        try:
            text += open(p, errors="ignore").read()
        except OSError as e:
            print(f"skip {p}: {e}")
    if not text:
        print("no log content")
        return 2

    counts = Counter()
    hosts_recorded = Counter()
    refusals = Counter()
    not_replayed = Counter()
    for line in text.splitlines():
        for label, rx in PATTERNS:
            m = rx.search(line)
            if not m:
                continue
            counts[label] += 1
            if label == "recorded":
                hosts_recorded[m.group(2)] += 1
            if label == "not_recorded":
                refusals[m.group(1)] += 1
            if label == "not_replayed":
                not_replayed[m.group(2)[:60]] += 1

    gate_passed = counts["gate_passed"]
    recorded = counts["recorded"] + counts["re_derived"]
    print("=== RECORDING ===")
    print(f"  runs reaching the record gate : {gate_passed + counts['gate_refused']}")
    print(f"  gate PASSED (eligible)        : {gate_passed}")
    print(f"  skills recorded               : {recorded}"
          + (f"  ({100*recorded//gate_passed}% of eligible)" if gate_passed else ""))
    for why, n in refusals.most_common():
        print(f"    refused: {why}  x{n}")
    for h, n in hosts_recorded.most_common(10):
        print(f"    recorded on {h}  x{n}")

    print("\n=== REPLAY ===")
    print(f"  skill matched for the host    : {counts['matched']}")
    print(f"  no skill for the host         : {counts['no_skill']}")
    print(f"  full replay attempts          : {counts['replay_attempt']}")
    print(f"  full replays SUCCEEDED        : {counts['replay_ok']}")
    print(f"  prefix replays performed      : {counts['replay_prefix']}")
    print(f"  replays refused (unsafe step) : {counts['not_replayed']}")
    for why, n in not_replayed.most_common(6):
        print(f"    {why}  x{n}")
    print(f"  replay step failures          : {counts['replay_failed']}")
    replayed = counts["replay_attempt"] + counts["replay_prefix"]
    print(f"\n  RECORDING RATE {recorded}/{gate_passed}"
          f" = {100*recorded//gate_passed if gate_passed else 0}%   (criterion 9 wants >=50%)")
    print(f"  REPLAYS PERFORMED {replayed}, of which succeeded {counts['replay_ok']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
