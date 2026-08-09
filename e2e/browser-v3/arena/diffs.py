"""Where each competitor beats us, task by task, with the evidence trail for each loss.

This is the input to the ingest-and-iterate loop: for every (task, seed) where a competitor arm
succeeded and ours failed, print our step trace, their action list, and both screenshot paths, so
"what do they do better" is answered from recorded evidence rather than from impressions.

  python diffs.py --ours osw-llm --theirs bu-real
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recorder import load_episodes
from report import latest_per_key
from tasks import CATEGORY_OF


def pick(eps: list[dict], arm: str) -> dict[tuple[str, int], dict]:
    return {(e["task"], e["seed"]): e for e in eps if e["arm"] == arm}


def trace(ep: dict, limit: int = 8) -> list[str]:
    out = []
    for s in (ep.get("step_records") or [])[:limit]:
        err = f"  ERR:{s['action_error'][:60]}" if s.get("action_error") else ""
        out.append(f"    {s['step']:2d}. {s.get('action', '')[:80]}{err}")
    shots = [s["shot"] for s in ep.get("step_records") or [] if s.get("shot")]
    if shots:
        out.append(f"    shots: {shots[0]} .. {Path(shots[-1]).parent}/99.png")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", default="osw-llm")
    ap.add_argument("--theirs", default="bu-real")
    ap.add_argument("--tag", default="all")
    ap.add_argument("--show-ours-wins", action="store_true")
    args = ap.parse_args()

    eps = latest_per_key(load_episodes(args.tag))
    ours, theirs = pick(eps, args.ours), pick(eps, args.theirs)
    common = sorted(set(ours) & set(theirs))
    if not common:
        raise SystemExit(f"no common (task, seed) pairs between {args.ours} and {args.theirs}")

    they_beat_us = [k for k in common if theirs[k].get("success") and not ours[k].get("success")]
    we_beat_them = [k for k in common if ours[k].get("success") and not theirs[k].get("success")]
    both = sum(1 for k in common if ours[k].get("success") and theirs[k].get("success"))
    neither = sum(1 for k in common if not ours[k].get("success") and not theirs[k].get("success"))

    print(f"common episodes: {len(common)}  both-solve: {both}  neither: {neither}")
    print(f"{args.theirs} beats {args.ours}: {len(they_beat_us)}   "
          f"{args.ours} beats {args.theirs}: {len(we_beat_them)}\n")

    print(f"=== {args.theirs} solved, {args.ours} failed ===")
    for task, seed in they_beat_us:
        o, t = ours[(task, seed)], theirs[(task, seed)]
        print(f"\n{task} (s={seed}, {CATEGORY_OF.get(task, '?')})  goal: {o.get('goal', '')[:90]}")
        print(f"  ours   ({o['steps']} steps, {o['wall_s']:.1f}s, err={o.get('error_class') or '-'}):")
        print("\n".join(trace(o)))
        print(f"  theirs ({t['steps']} steps, {t['wall_s']:.1f}s):")
        print("\n".join(trace(t)))

    if args.show_ours_wins:
        print(f"\n=== {args.ours} solved, {args.theirs} failed ===")
        for task, seed in we_beat_them:
            t = theirs[(task, seed)]
            print(f"{task} (s={seed})  their steps={t['steps']} wall={t['wall_s']:.1f}s "
                  f"claimed={t.get('claimed_success')} err={t.get('error_detail', '')[:60]}")


if __name__ == "__main__":
    main()
