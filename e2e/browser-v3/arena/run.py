"""Run one arm over MiniWoB tasks and record every metric MiniWoB and the browser will give us.

Scoring is MiniWoB's own reward, read through BrowserGym. Nothing in this repo decides whether an
episode passed, which is the whole reason this harness exists: every other suite here was graded by
something I wrote and then tuned against.

  python run.py --arm openswarm --tasks all --seeds 3 --shots first-last
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import browsergym.miniwob  # noqa: F401  importing is what registers the 125 envs
import gymnasium as gym

import perception
import policies
from recorder import EpisodeRecord, Recorder, StepRecord, save_screenshot
from tasks import resolve_tasks

os.environ.setdefault("MINIWOB_URL", "http://localhost:8099/miniwob/")


class StepHang(Exception):
    """env.step exceeded the watchdog; the browser is presumed wedged for this episode."""


def with_deadline(fn: Any, timeout_s: float) -> Any:
    """One measured episode lost 901s inside a single env.step; never let a hang masquerade as skill time.

    SIGALRM, not a worker thread: sync Playwright pins its greenlet to the creating thread, and the
    threaded version died with 'cannot switch to a different thread' on the first click.
    """
    def on_alarm(signum: int, frame: Any) -> None:
        raise StepHang(f"call exceeded {timeout_s:.0f}s")

    prev = signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(max(1, int(timeout_s)))
    try:
        return fn()
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, prev)


def classify(exc: BaseException) -> str:
    """Separate a harness/browser failure from a policy failure so infra noise never scores as skill."""
    name = type(exc).__name__
    text = str(exc).lower()
    if isinstance(exc, StepHang):
        return "infra_step_hang"
    if "timeout" in text or "Timeout" in name:
        return "infra_timeout"
    if "target" in text and "closed" in text:
        return "infra_browser_closed"
    if "connection" in text or "econnrefused" in text:
        return "infra_connection"
    if "rate" in text and "limit" in text:
        return "llm_rate_limit"
    return f"error_{name}"


def run_episode(arm: str, task: str, seed: int, rec: Recorder, args: argparse.Namespace) -> EpisodeRecord:
    ep = EpisodeRecord(arm=arm, task=task, seed=seed, model=args.model or "", started_at=time.time())
    policy = policies.build(arm, model=args.model, endpoint=args.endpoint)
    t_setup = time.time()
    env = None
    holder: list[Any] = []
    try:
        # Setup under its own deadline: both 125-task sweeps once hung 30+ minutes in env
        # creation/reset with the step watchdog never armed. holder keeps a half-built env
        # reachable so the except path can close its browsers instead of leaking them.
        def setup():
            # coord subset on for EVERY arm: canvas/slider/drag tasks are unphrasable in pure bid
            # space, and the product this arena stands in for ships coordinate clicks (click_point).
            from browsergym.core.action.highlevel import HighLevelActionSet

            acts = HighLevelActionSet(subsets=["chat", "bid", "coord", "infeas"],
                                      strict=False, multiaction=False)
            holder.append(gym.make(f"browsergym/miniwob.{task}", headless=not args.headed,
                                   max_episode_steps=args.max_steps, wait_for_user_message=False,
                                   action_mapping=acts.to_python_code))
            return holder[0].reset(seed=seed)

        obs, _ = with_deadline(setup, args.setup_timeout)
        env = holder[0]
    except Exception as exc:
        ep.error_class = classify(exc)
        ep.error_detail = f"{type(exc).__name__}: {exc}"[:200]
        ep.setup_s = time.time() - t_setup
        if holder:
            try:
                with_deadline(holder[0].close, 15)
            except Exception:
                pass
        return ep
    ep.setup_s = time.time() - t_setup
    ep.goal = str(obs.get("goal") or "")[:300]
    policy.reset(ep.goal)

    t0 = time.time()
    try:
        for step in range(1, args.max_steps + 1):
            t_perc = time.time()
            nodes, ax_chars = perception.axtree_stats(obs)
            # The LLM call rides inside act(); urlopen's timeout does not cover every hang mode.
            decision = with_deadline(lambda: policy.act(obs, ep.goal), args.step_timeout + 90)
            perceive_ms = (time.time() - t_perc) * 1000
            rec_step = StepRecord(
                step=step, action=decision.action, perceive_ms=perceive_ms,
                think_ms=getattr(decision, "think_ms", 0.0),
                axtree_chars=ax_chars, axtree_nodes=nodes,
                dom_chars=perception.dom_chars(obs) if args.dom_metrics else 0,
                n_interactive=decision.n_interactive, url=str(obs.get("url") or ""),
                focused_bid=str(obs.get("focused_element_bid") or ""),
                prompt_tokens=getattr(decision, "prompt_tokens", 0),
                completion_tokens=getattr(decision, "completion_tokens", 0),
                cost_usd=getattr(decision, "cost_usd", 0.0),
                llm_error=getattr(decision, "llm_error", ""),
                retries=getattr(decision, "retries", 0),
            )
            if args.shots != "none":
                dest = rec.shot_path(arm, task, seed, step)
                rec_step.shot = save_screenshot(obs, dest)
            if not decision.action:
                rec_step.action_error = "policy produced no action"
                ep.add(rec_step)
                # A no-action turn caused by a dead LLM lane is the harness's problem, not the arm's.
                if getattr(decision, "llm_error", ""):
                    ep.error_class = "infra_llm"
                    ep.error_detail = decision.llm_error[:200]
                break
            if ep.first_action_s == 0.0:
                ep.first_action_s = time.time() - t0
            t_act = time.time()
            obs, reward, terminated, truncated, _ = with_deadline(
                lambda: env.step(decision.action), args.step_timeout)
            rec_step.action_ms = (time.time() - t_act) * 1000
            rec_step.reward = float(reward or 0)
            rec_step.action_error = str(obs.get("last_action_error") or "")[:200]
            ep.add(rec_step)
            ep.reward = max(ep.reward, float(reward or 0))
            ep.steps = step
            if terminated or truncated:
                ep.terminated, ep.truncated = bool(terminated), bool(truncated)
                break
    except Exception as exc:
        ep.error_class = classify(exc)
        ep.error_detail = f"{type(exc).__name__}: {exc}"[:200]
        if args.trace:
            traceback.print_exc()
    ep.wall_s = time.time() - t0
    ep.success = ep.reward > 0
    try:
        raw = with_deadline(lambda: env.unwrapped.page.evaluate(
            "typeof WOB_RAW_REWARD_GLOBAL !== 'undefined' ? WOB_RAW_REWARD_GLOBAL : 0"), 10)
        ep.raw_reward = float(raw or 0)
    except Exception:
        ep.raw_reward = ep.reward
    # Final frame AFTER the last action, which is the only one that shows why an episode scored 0.
    if args.shots != "none":
        try:
            with_deadline(lambda: env.unwrapped.page.screenshot(
                path=str(rec.shot_path(arm, task, seed, 99))), 10)
        except Exception:
            pass
    # close() can hang on the same wedged browser the step hung on; give it its own short leash.
    try:
        with_deadline(env.close, 15)
    except Exception:
        pass
    return ep


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True)
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--seeds", type=int, default=1)
    ap.add_argument("--seed-base", type=int, default=42)
    ap.add_argument("--max-steps", type=int, default=12)
    ap.add_argument("--step-timeout", type=float, default=30.0)
    ap.add_argument("--setup-timeout", type=float, default=60.0)
    ap.add_argument("--shots", choices=["none", "first-last", "all"], default="first-last")
    ap.add_argument("--dom-metrics", action="store_true")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--trace", action="store_true")
    ap.add_argument("--model", default=os.environ.get("OSW_ARENA_MODEL", ""))
    ap.add_argument("--endpoint", default=os.environ.get("OSW_ARENA_ENDPOINT", "http://localhost:20128"))
    ap.add_argument("--tag", default="")
    ap.add_argument("--run-id", default="")
    # Sharding, not threading: each shard owns its own browser, so one crash cannot poison the rest.
    ap.add_argument("--shard", default="", help="i/n, e.g. 0/4 to run every 4th task")
    args = ap.parse_args()

    tasks = resolve_tasks(args.tasks)
    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        tasks = [t for k, t in enumerate(tasks) if k % n == i]
    rec = Recorder(args.tag or args.arm, args.run_id)
    print(f"arm={args.arm} tasks={len(tasks)} seeds={args.seeds} -> {rec.path}", flush=True)
    wins = total = 0
    for task in tasks:
        for s in range(args.seeds):
            ep = run_episode(args.arm, task, args.seed_base + s, rec, args)
            rec.write(ep)
            total += 1
            wins += 1 if ep.success else 0
            flag = "OK " if ep.success else ("ERR" if ep.error_class else "-- ")
            print(f"  {flag} {task:28s} s={ep.seed} r={ep.reward:+.2f} steps={ep.steps:2d} "
                  f"{ep.wall_s:6.2f}s tok={ep.prompt_tokens + ep.completion_tokens:<6d} {ep.error_class}",
                  flush=True)
    print(f"\n{args.arm}: {wins}/{total} = {100 * wins / total if total else 0:.1f}%", flush=True)


if __name__ == "__main__":
    main()
