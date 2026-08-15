"""Run one arm over MiniWoB tasks and record every metric MiniWoB and the browser will give us.

Scoring is MiniWoB's own reward, read through BrowserGym. Nothing in this repo decides whether an
episode passed, which is the whole reason this harness exists: every other suite here was graded by
something I wrote and then tuned against.

  python run.py --arm openswarm --tasks all --seeds 3 --shots first-last
"""
from __future__ import annotations

import argparse
import os
import re
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


def picker_value_fallback(page: Any, bid: str, value: str) -> str:
    """READONLY pickers reject fill by design -- the page wants you to use its widget. So use its
    widget: drive the picker's own API with the attempted value. Returns a note or '' if n/a."""
    try:
        ok = page.evaluate(
            """([bid, val]) => {
                 const el = document.querySelector(`[bid="${bid}"]`);
                 if (!el || !el.readOnly) return '';
                 if (typeof jQuery !== 'undefined' && jQuery(el).hasClass('hasDatepicker')) {
                   const m = val.match(/(\\d{4})-(\\d{2})-(\\d{2})/);
                   if (m) { jQuery(el).datepicker('setDate', new Date(+m[1], +m[2]-1, +m[3])); return 'datepicker'; }
                 }
                 el.value = val;
                 el.dispatchEvent(new Event('input', {bubbles: true}));
                 el.dispatchEvent(new Event('change', {bubbles: true}));
                 return 'value+events';
               }""", [bid, value])
        return str(ok or "")
    except Exception:
        return ""


def classify(exc: BaseException) -> str:
    """Separate a harness/browser failure from a policy failure so infra noise never scores as skill."""
    name = type(exc).__name__
    text = str(exc).lower()
    if isinstance(exc, StepHang):
        return "infra_step_hang"
    if "no running event loop" in text or "has been closed" in text:
        return "infra_playwright_state"
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

            # multiaction on: a form turn is fill+fill+click in ONE model call -- fewer calls is
            # simultaneously faster and stronger on multi-step tasks (browser-use does the same).
            acts = HighLevelActionSet(subsets=["chat", "bid", "coord", "nav", "infeas"],
                                      strict=False, multiaction=True)
            # A task name containing '.' is a full BrowserGym suffix (assistantbench.validation.3);
            # bare names stay MiniWoB. One grader per suite, none of them ours.
            if task.startswith("compwob."):
                import compwob  # noqa: F401  registers the 101 composed tasks
            elif task.startswith("webarena_verified."):
                for k, v in (("SHOPPING", "http://localhost:7770"), ("SHOPPING_ADMIN", "http://localhost:7780/admin"),
                             ("REDDIT", "http://localhost:9999"), ("GITLAB", "http://localhost:8023"),
                             ("WIKIPEDIA", "http://localhost:8888"), ("MAP", "http://localhost:3000"),
                             ("HOMEPAGE", "http://localhost:4399")):
                    os.environ.setdefault(f"WA_{k}", v)
                import browsergym.webarena_verified  # noqa: F401  registers the 812 Verified tasks
            elif task.startswith("webchorearena."):
                # Same self-hosted sites as WebArena; tasks/evaluator are theirs (COLM 2026).
                # Runs under the ISOLATED chore-venv (their browsergym fork) -- never the main venv.
                for k, v in (("SHOPPING", "http://localhost:7770"), ("SHOPPING_ADMIN", "http://localhost:7780/admin"),
                             ("REDDIT", "http://localhost:9999"), ("GITLAB", "http://localhost:8023"),
                             ("WIKIPEDIA", "http://localhost:8888"), ("MAP", "http://localhost:3000"),
                             ("HOMEPAGE", "http://localhost:4399")):
                    os.environ.setdefault(f"WA_{k}", v)
                import browsergym.webchorearena  # noqa: F401  registers the 538 chore tasks
            elif "." in task:
                # Lazy: importing assistantbench pulls HF datasets' multiprocessing machinery in,
                # which corrupts sync-playwright's event loop for the WHOLE process -- 248 of 252
                # v16 MiniWoB episodes died to it before this moved out of module scope.
                import browsergym.assistantbench  # noqa: F401
            env_id = f"browsergym/{task}" if "." in task else f"browsergym/miniwob.{task}"
            holder.append(gym.make(env_id, headless=not args.headed,
                                   max_episode_steps=args.max_steps, wait_for_user_message=False,
                                   action_mapping=acts.to_python_code))
            return holder[0].reset(seed=seed)

        # The composed pages' own genProblem can lose a load race and crash reset (measured:
        # 1/101 for our launch path, 73/101 for the CDP-port path -- same pages, same seed).
        # An environment race is infra, and it gets the same retry courtesy on every arm.
        last_exc = None
        for _attempt in range(3):
            try:
                obs, _ = with_deadline(setup, args.setup_timeout)
                break
            except Exception as exc:
                last_exc = exc
                if "Cannot set properties" not in str(exc) and "genProblem" not in str(exc):
                    raise
                if holder:
                    try: with_deadline(holder[0].close, 10)
                    except Exception: pass
                    holder.clear()
                time.sleep(2)
        else:
            raise last_exc
        env = holder[0]
        # Runway scales with instruction complexity -- a 7-clause goal legitimately needs ~3 steps
        # per clause. Feature-triggered (comma/then/and counts), never task names; capped at 3x.
        goal_now = str(obs.get("goal") or "")
        import re as _re
        clauses = 1 + len(_re.findall(r",| then | and then |after you|after clicking", goal_now))
        if clauses >= 4:
            grown = min(args.max_steps * 3, max(args.max_steps, clauses * 5))
            if grown > args.max_steps:
                env._max_episode_steps = grown  # gym TimeLimit wrapper attribute
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
    ep.goal = str(obs.get("goal") or "")[:600]
    policy.reset(ep.goal)

    t0 = time.time()
    try:
        for step in range(1, args.max_steps + 1):
            t_perc = time.time()
            # Q&A goals are scored on the CHAT ANSWER; an episode that pages forever and never
            # answers scores 0 no matter what it learned (measured: 1/17 chore episodes sent one).
            # On the last budgeted step, tell the policy the budget is up so it answers NOW.
            if (step == args.max_steps and hasattr(policy, "history")
                    and re.search(r"^(calculate|how many|what|which|find|count|tell me|list|give me)|\?\s*$",
                                  ep.goal.strip(), re.I)):
                policy.history.append("(FINAL STEP: budget exhausted -- if the goal asks for "
                                      "information, reply ONLY send_msg_to_user(\"<your best answer>\") now)")
            nodes, ax_chars = perception.axtree_stats(obs)
            # The LLM call rides inside act(); urlopen's timeout does not cover every hang mode.
            decision = with_deadline(lambda: policy.act(obs, ep.goal), args.step_timeout + 90)
            perceive_ms = (time.time() - t_perc) * 1000
            tgt = ""
            i2b, rnames = getattr(policy, "index_to_bid", None), getattr(policy, "row_names", None)
            if i2b and rnames:
                b2n = {b: rnames.get(i, "") for i, b in i2b.items()}
                hit = [n for n in (b2n.get(m) for m in re.findall(r'"([^"]+)"', decision.action)) if n]
                tgt = " | ".join(hit)[:160]
            rec_step = StepRecord(
                step=step, action=decision.action, target=tgt, perceive_ms=perceive_ms,
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
                vision=getattr(decision, "vision", 0),
            )
            if args.shots != "none":
                dest = rec.shot_path(arm, task, seed, step)
                rec_step.shot = save_screenshot(obs, dest)
            if not decision.action:
                rec_step.action_error = ("policy produced no action | RAW: " + getattr(decision, "raw_tail", ""))[:400]
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
            err = str(obs.get("last_action_error") or "")
            # v30 (gated by the arm): a click that times out on actionability is usually COVERED by
            # an overlay (dialog, banner, sticky bar). Playwright knows; the model only hears
            # 'TimeoutError'. Name the blocker so the model can move/close it and retry.
            if (getattr(policy, "native_js_fallback", False) and "Timeout" in err
                    and re.match(r"fill\(", decision.action)):
                m_f = re.match(r'fill\(\s*"([^"]+)"\s*,\s*"([^"]*)"', decision.action)
                if m_f:
                    how = picker_value_fallback(env.unwrapped.page, m_f.group(1), m_f.group(2))
                    if how:
                        err = (f"READONLY input: your value was applied through the page's own "
                               f"{how} machinery instead -- verify it on the page and continue | {err}")
                        obs["last_action_error"] = err
            if (getattr(policy, "blocker_probe", False) and "Timeout" in err
                    and re.match(r"(?:dbl)?click\(", decision.action)):
                m_bid = re.search(r'"([^"]+)"', decision.action)
                if m_bid:
                    try:
                        # Rect computed in-page from the live element (extra_element_properties
                        # bboxes go stale post-step and once pointed the probe at BODY).
                        top = with_deadline(lambda: env.unwrapped.page.evaluate(
                            "(bid) => { const el = document.querySelector(`[bid=\"${bid}\"]`);"
                            " if (!el) return ''; const r = el.getBoundingClientRect();"
                            " const e = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);"
                            " if (!e || e === el || el.contains(e)) return '';"
                            " return e.tagName + (e.id?'#'+e.id:'') +"
                            " (e.className&&typeof e.className==='string'?'.'+e.className.split(' ')[0]:''); }",
                            m_bid.group(1)), 8)
                        if top:
                            forced = ""
                            if getattr(policy, "force_unblock", False):
                                # v32: dispatch the click on the element anyway (what CDP-driven
                                # stacks do natively -- occlusion never stops them). The page's
                                # listener decides if it counts; the model is told either way.
                                ok = with_deadline(lambda: env.unwrapped.page.evaluate(
                                    "(bid) => { const el = document.querySelector(`[bid=\"${bid}\"]`);"
                                    " if (!el) return false; el.click(); return true; }",
                                    m_bid.group(1)), 8)
                                if ok:
                                    forced = ("; the click was DISPATCHED anyway and may have "
                                              "registered -- check the page before repeating it")
                            # PREPENDED: a suffix after Playwright's multi-line call log gets
                            # truncated out of both the record and the model's history.
                            err = (f"BLOCKED: {top} is covering the element you clicked{forced} -- "
                                   f"if it did not register, move or close the cover and retry | {err}")
                            obs["last_action_error"] = err
                    except Exception:
                        pass
            rec_step.action_error = err[:260]
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
    # success (reward>0) is MiniWoB semantics: pages pay only on completion. WebArena-family
    # rewards are FRACTIONAL checkpoint credit, so reward>0 is "made progress", not "solved" --
    # `strict` carries the solved bit for every benchmark so no report can conflate them again.
    ep.success = ep.reward > 0
    ep.strict = ep.reward >= 1.0
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
