"""Criterion 2 across rounds: verified writes, false successes, and every marker that was left live.

The canary prints a per-round summary; the criterion asks about the whole sample. Parses the round
output rather than re-running anything, so the numbers can be re-derived from the artifact.

    python3 c2_tally.py c2_r7.txt
"""

import re
import sys
from collections import Counter

ROW = re.compile(r"^\s+\[(PASS|DRIFT)\]\s+(\S+)\s+(canary[0-9a-f]+)?\s*stage=(\S+)\s+(.*)$")
PROVEN = re.compile(r"verified writes: (\d+)/(\d+) proven")
LIARS = re.compile(r"FALSE SUCCESS CLAIMS: (\d+)")
# re.M or `$` only matches the very end of the file and this finds nothing at all,
# which reads as "nothing was stranded" -- the exact wrong direction for this line.
STRANDED = re.compile(r"MANUAL CLEANUP NEEDED: (.+)$", re.M)


def main() -> int:
    text = open(sys.argv[1], errors="ignore").read()
    rounds = text.count("########## ROUND")
    proven = denom = liars = 0
    for m in PROVEN.finditer(text):
        proven += int(m.group(1))
        denom += int(m.group(2))
    for m in LIARS.finditer(text):
        liars += int(m.group(1))

    per_site = {}
    stages = Counter()
    for line in text.splitlines():
        m = ROW.match(line)
        if not m:
            continue
        flag, site, marker, stage, detail = m.groups()
        d = per_site.setdefault(site, Counter())
        d[stage] += 1
        d["rows"] += 1
        if flag == "PASS":
            d["pass"] += 1
        stages[stage] += 1

    print(f"rounds completed: {rounds}")
    print(f"\nVERIFIED WRITES: {proven}/{denom}"
          f" = {round(100*proven/denom) if denom else 0}%   (criterion 2 wants >=95%)")
    print(f"FALSE SUCCESS CLAIMS: {liars}   (criterion 3 hard gate, must be 0)")
    print("\nper site (a row is one full post+audit+delete+audit round trip):")
    print(f"  {'site':<10}{'rows':>5}{'pass':>6}  stages")
    for site, d in sorted(per_site.items()):
        st = {k: v for k, v in d.items() if k not in ("rows", "pass")}
        print(f"  {site:<10}{d['rows']:>5}{d['pass']:>6}  {st}")

    stranded = []
    for m in STRANDED.finditer(text):
        stranded.extend(x.strip() for x in m.group(1).split(","))
    print(f"\nmarkers the canary could not clean up: {len(stranded)}")
    for s in stranded:
        print(f"  {s}")
    if stranded:
        print("  ^ verify by hand with bench/rawbrowser.py before calling this run finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
