"""Stagehand's agent on MiniWoB: same seeded page, same CDP attach, same external scorer as bu-real.

The node driver does the acting; this file owns the env, the clock, the record, and the verdict.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bu_real import CDP_PORT, make_env, score
from recorder import EpisodeRecord, Recorder, StepRecord
from tasks import resolve_tasks

os.environ.setdefault("MINIWOB_URL", "http://localhost:8099/miniwob/")
DRIVER = Path(__file__).resolve().parent / "sh_driver.mjs"
NODE_DIR = os.environ.get("OSW_ARENA_SH_DIR", "")


def drive(goal: str, model: str, endpoint: str, max_steps: int, timeout_s: float) -> dict:
    cmd = ["node", str(DRIVER), goal, f"http://localhost:{CDP_PORT}", model, endpoint, str(max_steps)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s,
                              cwd=NODE_DIR or None)
    except subprocess.TimeoutExpired:
        return {"errors": [f"driver exceeded {timeout_s:.0f}s"]}
    for line in reversed(proc.stdout.splitlines()):
        if line.startswith("RESULT:"):
            try:
                return json.loads(line[len("RESULT:"):])
            except ValueError:
                break
    return {"errors": [f"no RESULT line; rc={proc.returncode}; tail={proc.stdout[-200:]!r} {proc.stderr[-200:]!r}"]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="smoke")
    ap.add_argument("--seeds", type=int, default=1)
    ap.add_argument("--seed-base", type=int, default=42)
    ap.add_argument("--max-steps", type=int, default=12)
    ap.add_argument("--episode-timeout", type=float, default=180.0)
    ap.add_argument("--model", default=os.environ.get("OSW_ARENA_MODEL", "cc/claude-sonnet-4-6"))
    ap.add_argument("--endpoint", default=os.environ.get("OSW_ARENA_ENDPOINT", "http://localhost:20128"))
    ap.add_argument("--shots", choices=["none", "first-last"], default="first-last")
    ap.add_argument("--shard", default="")
    args = ap.parse_args()

    tasks = resolve_tasks(args.tasks)
    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        tasks = [t for k, t in enumerate(tasks) if k % n == i]
    rec = Recorder("sh-real")
    print(f"arm=sh-real tasks={len(tasks)} seeds={args.seeds} model={args.model} -> {rec.path}", flush=True)
    wins = total = 0
    for task in tasks:
        for s in range(args.seeds):
            seed = args.seed_base + s
            ep = EpisodeRecord(arm="sh-real", task=task, seed=seed, model=args.model,
                               started_at=time.time())
            t_setup = time.time()
            env = None
            try:
                env, obs = make_env(task, seed, args.max_steps)
                ep.goal = str(obs.get("goal") or "")[:300]
            except Exception as exc:
                ep.error_class = "infra_env_setup"
                ep.error_detail = f"{type(exc).__name__}: {exc}"[:200]
            ep.setup_s = time.time() - t_setup
            if env is not None:
                if args.shots != "none":
                    try:
                        env.unwrapped.page.screenshot(path=str(rec.shot_path("sh-real", task, seed, 1)))
                    except Exception:
                        pass
                t0 = time.time()
                stats = drive(ep.goal, args.model, args.endpoint, args.max_steps, args.episode_timeout)
                ep.wall_s = time.time() - t0
                try:
                    ep.reward, ep.raw_reward = score(env)
                except Exception as exc:
                    ep.error_class = "infra_score_readback"
                    ep.error_detail = f"{type(exc).__name__}: {exc}"[:200]
                ep.success = ep.reward > 0
                ep.claimed_success = bool(stats.get("claimed"))
                ep.steps = int(stats.get("steps") or 0)
                usage = stats.get("usage") or {}
                ep.prompt_tokens = int(usage.get("input_tokens") or 0)
                ep.completion_tokens = int(usage.get("output_tokens") or 0)
                ep.llm_calls = int(usage.get("inference_time_ms") is not None and ep.steps or ep.steps)
                errs = stats.get("errors") or []
                if errs and not ep.success:
                    ep.error_detail = (ep.error_detail + " | " + "; ".join(errs))[:200].strip(" |")
                for i, act in enumerate(stats.get("actions") or [], 1):
                    ep.step_records.append(StepRecord(step=i, action=str(act)[:120]))
                if args.shots != "none":
                    try:
                        env.unwrapped.page.screenshot(path=str(rec.shot_path("sh-real", task, seed, 99)))
                    except Exception:
                        pass
                try:
                    env.close()
                except Exception:
                    pass
            rec.write(ep)
            total += 1
            wins += 1 if ep.success else 0
            flag = "OK " if ep.success else ("ERR" if ep.error_class else "-- ")
            lie = " FALSE-SUCCESS" if ep.claimed_success and not ep.success else ""
            print(f"  {flag} {task:28s} s={seed} r={ep.reward:+.2f} steps={ep.steps:2d} "
                  f"{ep.wall_s:6.2f}s tok={ep.prompt_tokens + ep.completion_tokens:<7d} "
                  f"{ep.error_detail[:60]}{lie}", flush=True)
    print(f"\nsh-real: {wins}/{total} = {100 * wins / total if total else 0:.1f}%", flush=True)


if __name__ == "__main__":
    main()
