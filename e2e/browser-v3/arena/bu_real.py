"""The REAL browser-use agent on MiniWoB: their whole stack, our task instance, MiniWoB's scoring.

BrowserGym launches the chromium with a CDP port open; browser-use attaches to that same browser and
drives the very page BrowserGym seeded. Reward is read from MiniWoB's own WOB_REWARD_GLOBAL through
the BrowserGym handle, so browser-use's self-reported "done" never grades itself -- the lesson every
prior verifier bug in this project taught twice.

Separate entrypoint from run.py because browser-use is asyncio all the way down and forcing it under
run.py's sync SIGALRM loop would time THEIR stack with MY interruptions.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import browsergym.miniwob  # noqa: F401  registers the 125 envs
import gymnasium as gym

from recorder import EpisodeRecord, Recorder, StepRecord
from tasks import resolve_tasks

os.environ.setdefault("MINIWOB_URL", "http://localhost:8099/miniwob/")
CDP_PORT = int(os.environ.get("OSW_ARENA_CDP_PORT", "9321"))


def patch_launch_with_cdp_port() -> None:
    """BrowserEnv passes args= itself, so pw_chromium_kwargs={'args': ...} raises; inject at launch.

    Every launch gets its OWN port: BrowserGym starts a second chromium just for its chat window, and
    when both raced for one port the chat browser won it -- browser-use then spent 10 steps staring
    at the chat page's about:blank hunting for a Submit button that was in the other browser.
    """
    from playwright.sync_api import BrowserType

    if getattr(BrowserType, "osw_arena_patched", False):
        return
    orig = BrowserType.launch

    def launch(self, **kwargs):
        # A genuinely-free port each launch: fixed pools deadlocked -- a zombie chromium from a dead
        # episode kept its port bound and the next launch hung 180s failing to bind the same one.
        import socket

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        RECENT_PORTS.append(port)
        del RECENT_PORTS[:-8]
        kwargs["args"] = list(kwargs.get("args") or []) + [f"--remote-debugging-port={port}"]
        return orig(self, **kwargs)

    BrowserType.launch = launch
    BrowserType.osw_arena_patched = True


# Ports handed to recent launches, newest last; the probe below only ever looks here.
RECENT_PORTS: list[int] = []


def find_task_cdp_url() -> str:
    """Probe the recently-issued ports for the browser actually hosting the MiniWoB page."""
    import urllib.request

    for port in reversed(RECENT_PORTS):
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/json", timeout=2) as resp:
                targets = json.loads(resp.read().decode())
        except Exception:
            continue
        if any("miniwob" in str(t.get("url", "")) for t in targets):
            return f"http://localhost:{port}"
    raise RuntimeError(f"none of the recent CDP ports {RECENT_PORTS} hosts a miniwob page")


def reap_leftover_browsers() -> None:
    """Kill any debug-port chromium THIS process launched that outlived its episode; zombies wedge
    later launches. Per-port patterns, not a blanket sweep, so concurrent shards and other arms'
    portless chromiums are untouchable by construction."""
    import subprocess

    for port in RECENT_PORTS:
        subprocess.run(["pkill", "-f", f"ms-playwright.*remote-debugging-port={port}$"],
                       capture_output=True, check=False)
        subprocess.run(["pkill", "-f", f"ms-playwright.*remote-debugging-port={port} "],
                       capture_output=True, check=False)


def make_env(task: str, seed: int, max_steps: int):
    patch_launch_with_cdp_port()
    env = gym.make(f"browsergym/miniwob.{task}", headless=True, max_episode_steps=max_steps)
    obs, _ = env.reset(seed=seed)
    return env, obs


async def drive(goal: str, cdp_url: str, model: str, endpoint: str, max_steps: int, timeout_s: float) -> dict:
    """Run browser-use's own Agent loop against the already-open task page."""
    from browser_use import Agent, Browser, ChatOpenAI

    browser = Browser(cdp_url=cdp_url, is_local=False)
    llm = ChatOpenAI(model=model, base_url=f"{endpoint}/v1", api_key="arena", temperature=None)
    # MiniWoB pages never navigate, so the task prompt forbids goto -- their agent otherwise likes to
    # open about:blank or a search engine, which would abandon the scored page.
    agent = Agent(
        task=f"{goal}\nWork ONLY on the currently open page. Never navigate to another URL.",
        llm=llm, browser=browser, calculate_cost=True,
    )

    async def run_agent():
        # Everything of theirs -- connect, session setup, the loop -- inside ONE deadline. Wrapping
        # only agent.run let a wedged phase outside it stretch an episode to 1467s.
        return await agent.run(max_steps=max_steps)

    stats = {"llm_calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "actions": []}
    try:
        history = await asyncio.wait_for(run_agent(), timeout=timeout_s)
        stats["actions"] = [str(a)[:120] for a in history.action_names()]
        try:
            stats["claimed_success"] = bool(history.is_successful())
        except Exception:
            stats["claimed_success"] = False
        usage = getattr(history, "usage", None)
        if usage:
            stats["prompt_tokens"] = int(getattr(usage, "total_prompt_tokens", 0) or 0)
            stats["completion_tokens"] = int(getattr(usage, "total_completion_tokens", 0) or 0)
            stats["llm_calls"] = int(getattr(usage, "total_calls", len(stats["actions"])) or 0)
    except asyncio.TimeoutError:
        stats["error"] = f"agent.run exceeded {timeout_s:.0f}s"
    except Exception as exc:
        stats["error"] = f"{type(exc).__name__}: {exc}"[:200]
    finally:
        try:
            await asyncio.wait_for(browser.stop(), timeout=10)
        except Exception:
            pass
    return stats


def drive_in_thread(goal: str, cdp_url: str, model: str, endpoint: str, max_steps: int, timeout_s: float) -> dict:
    """Own thread, own event loop: sync-Playwright's greenlet already occupies this thread's loop,
    so asyncio.run() here raises 'cannot be called from a running event loop'. browser-use only
    touches the browser over CDP, so it needs nothing from this thread's Playwright state."""
    import threading

    result: dict = {}

    def runner() -> None:
        try:
            result.update(asyncio.run(drive(goal, cdp_url, model, endpoint, max_steps, timeout_s)))
        except Exception as exc:
            result["error"] = f"{type(exc).__name__}: {exc}"[:200]

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    t.join(timeout=timeout_s + 30)
    if t.is_alive():
        result.setdefault("error", f"driver thread still alive after {timeout_s + 30:.0f}s")
    return result


def score(env) -> tuple[float, float]:
    """MiniWoB's verdict, read straight off the page globals -- the only grader in this file."""
    page = env.unwrapped.page
    reward = float(page.evaluate("typeof WOB_REWARD_GLOBAL !== 'undefined' ? WOB_REWARD_GLOBAL : 0") or 0)
    raw = float(page.evaluate("typeof WOB_RAW_REWARD_GLOBAL !== 'undefined' ? WOB_RAW_REWARD_GLOBAL : 0") or 0)
    return reward, raw


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
    rec = Recorder("bu-real")
    print(f"arm=bu-real tasks={len(tasks)} seeds={args.seeds} model={args.model} -> {rec.path}", flush=True)
    wins = total = 0
    for task in tasks:
        for s in range(args.seeds):
            seed = args.seed_base + s
            ep = EpisodeRecord(arm="bu-real", task=task, seed=seed, model=args.model,
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
                        env.unwrapped.page.screenshot(path=str(rec.shot_path("bu-real", task, seed, 1)))
                    except Exception:
                        pass
                t0 = time.time()
                try:
                    cdp_url = find_task_cdp_url()
                except Exception as exc:
                    cdp_url = ""
                    ep.error_class = "infra_cdp_probe"
                    ep.error_detail = str(exc)[:200]
                stats = drive_in_thread(ep.goal, cdp_url, args.model, args.endpoint,
                                        args.max_steps, args.episode_timeout) if cdp_url else {}
                ep.wall_s = time.time() - t0
                try:
                    ep.reward, ep.raw_reward = score(env)
                except Exception as exc:
                    ep.error_class = ep.error_class or "infra_score_readback"
                    ep.error_detail = f"{type(exc).__name__}: {exc}"[:200]
                ep.success = ep.reward > 0
                ep.claimed_success = bool(stats.get("claimed_success"))
                ep.steps = len(stats.get("actions") or [])
                ep.prompt_tokens = stats.get("prompt_tokens", 0)
                ep.completion_tokens = stats.get("completion_tokens", 0)
                ep.llm_calls = stats.get("llm_calls", 0)
                if stats.get("error") and not ep.success:
                    ep.error_detail = (ep.error_detail + " | " + stats["error"])[:200].strip(" |")
                for i, act in enumerate(stats.get("actions") or [], 1):
                    ep.step_records.append(StepRecord(step=i, action=act))
                if args.shots != "none":
                    try:
                        env.unwrapped.page.screenshot(path=str(rec.shot_path("bu-real", task, seed, 99)))
                    except Exception:
                        pass
                try:
                    env.close()
                except Exception:
                    pass
                reap_leftover_browsers()
            rec.write(ep)
            total += 1
            wins += 1 if ep.success else 0
            flag = "OK " if ep.success else ("ERR" if ep.error_class else "-- ")
            lie = " FALSE-SUCCESS" if ep.claimed_success and not ep.success else ""
            print(f"  {flag} {task:28s} s={seed} r={ep.reward:+.2f} steps={ep.steps:2d} "
                  f"{ep.wall_s:6.2f}s tok={ep.prompt_tokens + ep.completion_tokens:<7d} "
                  f"{ep.error_detail[:60]}{lie}", flush=True)
    print(f"\nbu-real: {wins}/{total} = {100 * wins / total if total else 0:.1f}%", flush=True)


if __name__ == "__main__":
    main()
