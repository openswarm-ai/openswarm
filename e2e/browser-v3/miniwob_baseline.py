"""MiniWoB via BrowserGym, scored by the benchmark itself rather than by anything I wrote.

This is the piece every other measurement in this session lacked: ground truth someone else defined.
Our own suites are ones I built and then tuned against; MiniWoB's reward comes from the task, so a
number here cannot be flattered by the harness author.

The policy under test is deliberately trivial -- a deterministic accessibility-tree heuristic with NO
model: read the flattened axtree, pick the element the goal names, click or fill it. The point is to
establish what the FREE, no-LLM baseline scores, because that is the bar any model-driven agent has
to beat to justify its latency and cost.
"""
import re
import sys
import time

import gymnasium as gym
import browsergym.miniwob  # noqa: F401  registers the envs
from browsergym.utils.obs import flatten_axtree_to_str

TASKS = sys.argv[1:] or [
    "click-test", "click-button", "click-link", "click-checkboxes", "click-dialog",
    "enter-text", "enter-text-dynamic", "focus-text", "focus-text-2", "enter-password",
    "click-tab", "navigate-tree", "click-option", "simple-algebra", "login-user",
]


def act(ax: str, goal: str):
    """One deterministic step from the axtree. No model, no learning, ~20 lines."""
    goal_l = goal.lower()
    # A quoted target in the goal names the element outright; prefer an exact label match on it.
    want = re.findall(r'"([^"]+)"', goal) + re.findall(r"'([^']+)'", goal)
    rows = re.findall(r"\[(\d+)\]\s+(\w+)\s*'([^']*)'", ax)
    if not rows:
        return None
    if want:
        for bid, role, name in rows:
            if any(w.lower() == name.lower() for w in want):
                return f'click("{bid}")'
    # Typing goals: fill the first textbox with the quoted payload, then submit if one is offered.
    if any(k in goal_l for k in ("enter", "type", "text", "password")):
        for bid, role, name in rows:
            if role in ("textbox", "searchbox"):
                payload = want[0] if want else "hello"
                return f'fill("{bid}", "{payload}")'
    for bid, role, name in rows:
        if role in ("button", "link", "checkbox", "tab", "option"):
            return f'click("{bid}")'
    return f'click("{rows[0][0]}")'


def main() -> None:
    wins = 0
    total = 0
    walls = []
    print(f"{'task':22s}{'reward':>8}{'steps':>7}{'wall_s':>9}")
    for t in TASKS:
        try:
            env = gym.make(f"browsergym/miniwob.{t}", headless=True, max_episode_steps=8)
        except Exception as e:
            print(f"{t:22s}{'ENV ERR':>8}  {type(e).__name__}")
            continue
        t0 = time.time()
        reward, steps = 0.0, 0
        try:
            obs, _ = env.reset(seed=42)
            goal = str(obs.get("goal") or "")
            for steps in range(1, 9):
                a = act(flatten_axtree_to_str(obs["axtree_object"]), goal)
                if not a:
                    break
                obs, r, term, trunc, _ = env.step(a)
                reward = max(reward, float(r or 0))
                if term or trunc:
                    break
        except Exception as e:
            print(f"{t:22s}{'RUN ERR':>8}  {type(e).__name__}: {str(e)[:40]}")
            try:
                env.close()
            except Exception:
                pass
            continue
        w = time.time() - t0
        walls.append(w)
        total += 1
        wins += 1 if reward > 0 else 0
        print(f"{t:22s}{reward:>8.2f}{steps:>7d}{w:>9.2f}")
        env.close()
    import statistics
    print(f"\nno-LLM axtree heuristic: {wins}/{total} = {100*wins/total if total else 0:.0f}%"
          f"  median wall {statistics.median(walls):.2f}s" if walls else "no runs")


if __name__ == "__main__":
    main()
