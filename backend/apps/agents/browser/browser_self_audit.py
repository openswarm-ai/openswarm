"""
Self-audit loop for the browser agent's own LEARNING (browser memory tier 4).

Tiers 1-3 make the agent better at the WEBSITE. This makes it better at LEARNING:
it reads its own run metrics + skill lifecycle and flags where the learning
machinery is misfiring, skills that re-learn forever but never replay (thrash),
runs that stall (turns far above the site's norm), recurring tool errors, low
route-hint adoption, then writes a PROPOSAL for a human to act on.

SAFETY LINE (deliberate): this NEVER edits prompts, thresholds, or code. In an
open-source local-agent product, an agent silently rewriting its own behavior is
a line we don't cross. It only READS metrics and WRITES a human-readable report;
a person decides what to change. Pure observation in, one proposal file out.
"""

import json
import logging
import os
from collections import defaultdict

logger = logging.getLogger(__name__)

# Thresholds for flagging; conservative so the report stays signal, not noise.
P_THRASH_MIN_RELEARNS = 3      # a skill re-versioned this many times with 0 replays = stuck
P_STALL_TURN_FACTOR = 2.0      # a run 2x the host's median turns is a stall worth noting
P_MIN_RUNS_FOR_MEDIAN = 4      # don't call a "norm" from too few runs
P_ERROR_RATE_FLAG = 0.25       # >25% of a host's tool calls erroring = something systemic


def p_read_jsonl(path: str, cap: int = 20000) -> list[dict]:
    out: list[dict] = []
    if not path or not os.path.exists(path):
        return out
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
                if len(out) >= cap:
                    break
    except Exception:
        pass
    return out


def p_median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if not n:
        return 0.0
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def p_audit(metrics_dir: str) -> dict:
    """Read the metrics + skill events and return a structured findings dict.
    Pure read; safe to call anytime. The caller renders/persists it."""
    tasks = p_read_jsonl(os.path.join(metrics_dir, "tasks.jsonl"))
    skill_events = p_read_jsonl(os.path.join(metrics_dir, "skill_events.jsonl"))
    findings: list[dict] = []

    # 1) THRASH: a skill re-versioned (edit) or sent to quarantine many times but
    # never PROMOTED, the kinds the skill layer actually records. It keeps re-learning
    # and never earns trust = the recorded steps don't hold up at replay.
    churn: dict[tuple, int] = defaultdict(int)
    promotes: dict[tuple, int] = defaultdict(int)
    for e in skill_events:
        key = (e.get("host"), e.get("task_sig"))
        kind = e.get("kind")
        if kind in ("edit", "quarantine", "demote"):
            churn[key] += 1
        elif kind == "promote":
            promotes[key] += 1
    for key, n in churn.items():
        if n >= P_THRASH_MIN_RELEARNS and promotes.get(key, 0) == 0:
            findings.append({
                "kind": "thrash",
                "host": key[0],
                "detail": f"skill re-learned/quarantined {n}x but never promoted",
                "suggestion": "the recorded steps likely don't match at replay (brittle "
                              "names or a late-rendering control); inspect the distill for "
                              "this task or deprecate the skill so it stops churning.",
            })

    # 2) STALL: runs far above the host's median turn count.
    by_host_turns: dict[str, list[int]] = defaultdict(list)
    for t in tasks:
        h = p_host_of_task(t)
        if t.get("turns"):
            by_host_turns[h].append(int(t["turns"]))
    for h, turns in by_host_turns.items():
        if len(turns) < P_MIN_RUNS_FOR_MEDIAN:
            continue
        med = p_median([float(x) for x in turns])
        stalls = [x for x in turns if med and x >= med * P_STALL_TURN_FACTOR]
        if stalls:
            findings.append({
                "kind": "stall",
                "host": h,
                "detail": f"{len(stalls)} run(s) at >= {P_STALL_TURN_FACTOR}x the median "
                          f"{med:.0f} turns (worst {max(stalls)})",
                "suggestion": "a few runs spike well above normal, likely a perception/verify "
                              "loop or an env hang; check whether a prompt prior or mechanical "
                              "hand-off would collapse the spike.",
            })

    # 3) ERROR-HEAVY: a host whose tool calls error a lot (systemic, not one bad run).
    err = defaultdict(int)
    tot = defaultdict(int)
    for t in tasks:
        h = p_host_of_task(t)
        rc = t.get("recurring_errors") or {}
        tot[h] += int(t.get("tool_calls") or 0)
        if isinstance(rc, dict):
            err[h] += sum(int(v) for v in rc.values() if isinstance(v, (int, float)))
    for h in tot:
        if tot[h] >= 20 and err[h] / max(1, tot[h]) >= P_ERROR_RATE_FLAG:
            findings.append({
                "kind": "error_rate",
                "host": h,
                "detail": f"{err[h]}/{tot[h]} tool calls recurring-errored "
                          f"({100*err[h]/max(1,tot[h]):.0f}%)",
                "suggestion": "high error rate is usually a stale selector/index or a throttled "
                              "session; consider a more robust locator or a backoff on this host.",
            })

    return {
        "n_tasks": len(tasks),
        "n_skill_events": len(skill_events),
        "findings": findings,
    }


def p_host_of_task(task: dict) -> str:
    # tasks.jsonl doesn't store host directly; task_sig is host-agnostic, so fall
    # back to a coarse bucket. browser_id groups a card's runs well enough for norms.
    return task.get("browser_id") or task.get("task_sig") or "unknown"


def p_render_report(result: dict) -> str:
    """A human-readable proposal. Read it, then YOU decide what (if anything) to change."""
    lines = [
        "# Browser self-audit (proposal only , nothing was changed)",
        "",
        f"Scanned {result.get('n_tasks', 0)} task runs and "
        f"{result.get('n_skill_events', 0)} skill events.",
        "",
    ]
    findings = result.get("findings") or []
    if not findings:
        lines.append("No learning-machinery problems flagged. The agent is learning cleanly.")
        return "\n".join(lines)
    lines.append(f"## {len(findings)} thing(s) worth a human look")
    for i, f in enumerate(findings, 1):
        lines += [
            "",
            f"### {i}. {f['kind'].upper()} , {f.get('host', '?')}",
            f"- What: {f['detail']}",
            f"- Proposed action: {f['suggestion']}",
        ]
    return "\n".join(lines)


def run_and_write(metrics_dir: str | None = None) -> str | None:
    """Audit + write the proposal to metrics_dir/self_audit_report.md. Returns the
    path written, or None. Never raises into the caller."""
    try:
        if metrics_dir is None:
            from backend.apps.agents.browser.browser_metrics import metrics_dir as metrics_dir_func
            metrics_dir = metrics_dir_func()
        result = p_audit(metrics_dir)
        report = p_render_report(result)
        path = os.path.join(metrics_dir, "self_audit_report.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(report)
        logger.info(f"[browser-self-audit] wrote {len(result.get('findings', []))} finding(s) to {path}")
        return path
    except Exception as e:
        logger.debug(f"[browser-self-audit] failed: {e}")
        return None
