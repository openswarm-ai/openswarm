"""Every arm, every category, every metric, one table -- written from the recorder's book only.

This file computes; it never re-judges. Success is whatever MiniWoB's reward said at run time, and
if a number is not derivable from the recorded episodes it does not appear here.

  python report.py                 # summary across all recorded arms
  python report.py --by-task       # per-task win matrix
  python report.py --md ARENA.md   # write the markdown scoreboard
"""
from __future__ import annotations

import argparse
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recorder import load_episodes
from tasks import CATEGORIES, CATEGORY_OF


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Same interval the rest of browser-v3 reports, so numbers compare across documents."""
    if n == 0:
        return (0.0, 0.0)
    p = wins / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def med(vals: list[float]) -> float:
    return statistics.median(vals) if vals else 0.0


def latest_per_key(eps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reruns supersede: only the newest episode per (arm, task, seed) counts, so iteration is honest."""
    by_key: dict[tuple[str, str, int], dict[str, Any]] = {}
    for ep in eps:
        key = (ep["arm"], ep["task"], ep["seed"])
        cur = by_key.get(key)
        if cur is None or ep.get("started_at", 0) >= cur.get("started_at", 0):
            by_key[key] = ep
    return list(by_key.values())


def summarize(eps: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    arms: dict[str, dict[str, Any]] = {}
    for arm in sorted({e["arm"] for e in eps}):
        rows = [e for e in eps if e["arm"] == arm]
        clean = [e for e in rows if not str(e.get("error_class", "")).startswith("infra")]
        wins = sum(1 for e in clean if e.get("success"))
        lo, hi = wilson(wins, len(clean))
        arms[arm] = {
            "n": len(rows), "clean": len(clean), "wins": wins,
            "rate": wins / len(clean) if clean else 0.0, "lo": lo, "hi": hi,
            "infra": len(rows) - len(clean),
            "wall_med": med([e["wall_s"] for e in clean if e.get("wall_s")]),
            "wall_win_med": med([e["wall_s"] for e in clean if e.get("success")]),
            "steps_med": med([float(e["steps"]) for e in clean if e.get("steps")]),
            "tokens": sum(e.get("prompt_tokens", 0) + e.get("completion_tokens", 0) for e in rows),
            "llm_calls": sum(e.get("llm_calls", 0) for e in rows),
            "false_success": sum(1 for e in clean if e.get("claimed_success") and not e.get("success")),
            "by_cat": by_category(clean),
        }
    return arms


def by_category(rows: list[dict[str, Any]]) -> dict[str, tuple[int, int]]:
    out: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for e in rows:
        cat = CATEGORY_OF.get(e["task"], "other")
        out[cat][1] += 1
        out[cat][0] += 1 if e.get("success") else 0
    return {k: (v[0], v[1]) for k, v in out.items()}


def fmt_summary(arms: dict[str, dict[str, Any]], md: bool = False) -> str:
    lines: list[str] = []
    bar = "|" if md else " "
    if md:
        lines.append("| arm | solved | rate | 95% CI | med wall (win) | med steps | tokens | LLM calls | false-succ | infra |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
    else:
        lines.append(f"{'arm':12s} {'solved':>9s} {'rate':>7s} {'95% CI':>15s} {'wall(win)':>10s} "
                     f"{'steps':>6s} {'tokens':>9s} {'calls':>6s} {'false':>6s} {'infra':>6s}")
    for arm, s in sorted(arms.items(), key=lambda kv: -kv[1]["rate"]):
        ci = f"[{100 * s['lo']:.0f},{100 * s['hi']:.0f}]"
        row = [arm, f"{s['wins']}/{s['clean']}", f"{100 * s['rate']:.1f}%", ci,
               f"{s['wall_win_med']:.1f}s", f"{s['steps_med']:.0f}", f"{s['tokens']}",
               f"{s['llm_calls']}", f"{s['false_success']}", f"{s['infra']}"]
        lines.append(("| " + " | ".join(row) + " |") if md else
                     f"{row[0]:12s} {row[1]:>9s} {row[2]:>7s} {row[3]:>15s} {row[4]:>10s} "
                     f"{row[5]:>6s} {row[6]:>9s} {row[7]:>6s} {row[8]:>6s} {row[9]:>6s}")
    lines.append("")
    cats = sorted(CATEGORIES)
    if md:
        lines.append("| category | " + " | ".join(sorted(arms)) + " |")
        lines.append("|---|" + "---|" * len(arms))
    else:
        lines.append(f"{'category':16s}" + "".join(f"{a:>16s}" for a in sorted(arms)))
    for cat in cats:
        cells = []
        for arm in sorted(arms):
            w, n = arms[arm]["by_cat"].get(cat, (0, 0))
            cells.append(f"{w}/{n} ({100 * w / n:.0f}%)" if n else "-")
        lines.append(("| " + cat + " | " + " | ".join(cells) + " |") if md
                     else f"{cat:16s}" + "".join(f"{c:>16s}" for c in cells))
    return "\n".join(lines)


def fmt_by_task(eps: list[dict[str, Any]]) -> str:
    """Per-task matrix: the disagreements between arms are where every insight lives."""
    arms = sorted({e["arm"] for e in eps})
    by_tk: dict[str, dict[str, list[bool]]] = defaultdict(lambda: defaultdict(list))
    for e in eps:
        if not str(e.get("error_class", "")).startswith("infra"):
            by_tk[e["task"]][e["arm"]].append(bool(e.get("success")))
    lines = [f"{'task':30s}" + "".join(f"{a:>12s}" for a in arms)]
    for task in sorted(by_tk):
        cells = []
        for arm in arms:
            r = by_tk[task].get(arm)
            cells.append("-" if not r else f"{sum(r)}/{len(r)}")
        lines.append(f"{task:30s}" + "".join(f"{c:>12s}" for c in cells))
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="all")
    ap.add_argument("--by-task", action="store_true")
    ap.add_argument("--md", default="")
    # Cross-model rows never mix: an arm's rate is only meaningful against arms on the same lane.
    ap.add_argument("--model", default="", help="only episodes run on this model (or '' for LLM-free arms too)")
    args = ap.parse_args()
    eps = latest_per_key(load_episodes(args.tag))
    if args.model:
        eps = [e for e in eps if e.get("model", "") in (args.model, "")]
    if not eps:
        raise SystemExit("no recorded episodes")
    if args.by_task:
        print(fmt_by_task(eps))
        return
    arms = summarize(eps)
    print(fmt_summary(arms))
    if args.md:
        Path(args.md).write_text("# MiniWoB arena scoreboard\n\n" + fmt_summary(arms, md=True) + "\n")
        print(f"\nwrote {args.md}")


if __name__ == "__main__":
    main()
