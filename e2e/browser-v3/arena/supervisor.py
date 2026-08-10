"""Out-of-process supervision for arena sweeps: launch, watch for stalls, kill, resume, repeat.

In-process deadlines proved unreliable here twice -- SIGALRM's exception gets swallowed somewhere
inside playwright/gym retry loops and a sweep silently stops writing for half an hour. A supervisor
that watches the recorder file and kills the whole process tree is the only deadline the stack
cannot catch. Resume is free because the recorder is append-only and reports keep only the newest
episode per (arm, task, seed).

  python supervisor.py --arm osw-llm --model cc/claude-haiku-4-5-20251001 --stall 240
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from recorder import RESULTS_DIR
from tasks import ALL, resolve_tasks

PY = sys.executable
ARENA = Path(__file__).resolve().parent


def completed_tasks(arm: str, model: str, seed: int, since: float) -> set[str]:
    """Tasks with a usable (non-infra) episode for this arm+model+seed recorded after `since`."""
    path = RESULTS_DIR / f"{arm}.jsonl"
    done: set[str] = set()
    if not path.exists():
        return done
    with open(path) as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if (r.get("seed") == seed and r.get("started_at", 0) >= since
                    and r.get("model", "") in (model, "")
                    and not str(r.get("error_class", "")).startswith("infra")):
                done.add(r["task"])
    return done


def spawn(arm: str, tasks: list[str], args: argparse.Namespace) -> subprocess.Popen:
    if arm == "bu-real":
        cmd = [PY, str(ARENA / "bu_real.py"), "--tasks", ",".join(tasks), "--seeds", "1",
               "--seed-base", str(args.seed), "--model", args.model,
               "--episode-timeout", str(args.episode_timeout)]
    else:
        cmd = [PY, str(ARENA / "run.py"), "--arm", arm, "--tasks", ",".join(tasks), "--seeds", "1",
               "--seed-base", str(args.seed), "--model", args.model, "--shots", args.shots,
               "--max-steps", str(args.max_steps)]
    env = dict(os.environ)
    env.setdefault("MINIWOB_URL", "http://localhost:8099/miniwob/")
    env.setdefault("BROWSER_USE_LOGGING_LEVEL", "warning")
    env.setdefault("ANONYMIZED_TELEMETRY", "false")
    # Its own process group so a stall-kill takes the whole tree, chromiums included.
    return subprocess.Popen(cmd, cwd=str(ARENA), env=env, start_new_session=True,
                            stdout=open(args.log, "ab"), stderr=subprocess.STDOUT)


def kill_tree(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    subprocess.run(["pkill", "-f", "ms-playwright"], capture_output=True, check=False)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--stall", type=float, default=240.0, help="kill if no new episode lands this long")
    ap.add_argument("--rounds", type=int, default=12)
    ap.add_argument("--episode-timeout", type=float, default=100.0)
    ap.add_argument("--max-steps", type=int, default=12)
    ap.add_argument("--shots", default="first-last")
    ap.add_argument("--log", default="")
    # Resume window: episodes recorded after this epoch count as done, so a restarted supervisor
    # keeps the finished work of the run it replaces instead of re-running all 125.
    ap.add_argument("--since", type=float, default=0.0)
    args = ap.parse_args()
    args.log = args.log or f"/tmp/supervise_{args.arm}.log"

    wanted = set(resolve_tasks(args.tasks)) if args.tasks != "all" else set(ALL)
    t_run = args.since or time.time()
    path = RESULTS_DIR / f"{args.arm}.jsonl"
    for rnd in range(1, args.rounds + 1):
        remaining = sorted(wanted - completed_tasks(args.arm, args.model, args.seed, t_run))
        if not remaining:
            break
        print(f"[supervisor] round {rnd}: {len(remaining)} tasks remaining", flush=True)
        proc = spawn(args.arm, remaining, args)
        last_size = path.stat().st_size if path.exists() else 0
        last_change = time.time()
        while proc.poll() is None:
            time.sleep(10)
            size = path.stat().st_size if path.exists() else 0
            if size != last_size:
                last_size, last_change = size, time.time()
            elif time.time() - last_change > args.stall:
                print(f"[supervisor] stalled {args.stall:.0f}s; killing tree", flush=True)
                kill_tree(proc)
                break
        time.sleep(2)
    done = completed_tasks(args.arm, args.model, args.seed, t_run)
    print(f"[supervisor] finished: {len(done)}/{len(wanted)} tasks have clean episodes", flush=True)


if __name__ == "__main__":
    main()
