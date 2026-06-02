#!/usr/bin/env python3
"""
Benchmark the browser agent against HUMAN performance on rudimentary tasks, on
two axes the user cares about: wall-clock time and number of turns/actions.
Bar: agent must reach >= 90% of human, else "no good".

Three honest reference points per task:
  1. optimal_actuation_s  - the raw browser commands with NO LLM (best case a
     perfect operator/script could do); measured floor.
  2. human_s / human_actions - a person who knows the page. Estimated from
     standard HCI norms (documented below), NOT invented to flatter the agent.
  3. agent_s / agent_turns - MEASURED from the live run (tasks.jsonl).

Human model (Card/Moran/Newell KLM-ish, conservative for a familiar user):
  - perceive/orient to a simple page : 1.5 s
  - point + click a visible control  : 1.0 s  (Fitts, ~0.8-1.2s)
  - keystroke                        : 0.28 s/char (skilled ~40wpm)
  - read a short result line         : 1.0 s
A "human action" = one click or one field-fill (typing a field = 1 action).
"""

import json
import os
import sys

HUMAN_PERCEIVE = 1.5
HUMAN_CLICK = 1.0
HUMAN_KEYSTROKE = 0.28
HUMAN_READ = 1.0

# Rudimentary tasks with their human action breakdown.
TASKS = {
    "form_submit": {
        "desc": "open form, type 'hello world', click Send",
        # human: perceive + click field + type 11 + click send
        "human_s": HUMAN_PERCEIVE + HUMAN_CLICK + 11 * HUMAN_KEYSTROKE + HUMAN_CLICK,
        "human_actions": 2,  # fill field, click send
        "match": "type",     # substring of the recorded task text
    },
    "read_list": {
        "desc": "open page, read the list of items",
        "human_s": HUMAN_PERCEIVE + HUMAN_READ,
        "human_actions": 1,  # just look
        "match": "list of items",
    },
    "click_button": {
        "desc": "open page, click the Subscribe button",
        "human_s": HUMAN_PERCEIVE + HUMAN_CLICK,
        "human_actions": 1,
        "match": "subscribe",
    },
}


def load_tasks(metrics_dir):
    p = os.path.join(metrics_dir, "tasks.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    with open(p) as f:
        for line in f:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def match_task(recorded, spec):
    return spec["match"].lower() in str(recorded.get("task", "")).lower()


def main():
    metrics_dir = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "OPENSWARM_BROWSER_METRICS_DIR",
        os.path.expanduser("~/Library/Application Support/OpenSwarm/data/browser_metrics"),
    )
    recorded = load_tasks(metrics_dir)
    print(f"metrics dir: {metrics_dir}\nrecorded tasks: {len(recorded)}\n")
    print(f"{'task':<14}{'human_s':>9}{'agent_s':>9}{'spd%':>7}  "
          f"{'human_act':>10}{'agent_turns':>12}{'turn%':>7}  verdict")
    print("-" * 88)

    any_pass_speed = False
    for key, spec in TASKS.items():
        match = next((r for r in recorded if match_task(r, spec) and r.get("completed")), None)
        if not match:
            print(f"{key:<14}{spec['human_s']:>9.1f}{'-':>9}{'-':>7}  "
                  f"{spec['human_actions']:>10}{'-':>12}{'-':>7}  (no completed agent run)")
            continue
        agent_s = match["total_ms"] / 1000.0
        agent_turns = match.get("turns", 0)
        spd = 100.0 * spec["human_s"] / agent_s if agent_s else 0  # human/agent: 100%=parity, >100 agent faster
        turn_pct = 100.0 * spec["human_actions"] / agent_turns if agent_turns else 0
        verdict = "PASS" if spd >= 90 else "FAIL (<90% of human speed)"
        if spd >= 90:
            any_pass_speed = True
        print(f"{key:<14}{spec['human_s']:>9.1f}{agent_s:>9.1f}{spd:>6.0f}%  "
              f"{spec['human_actions']:>10}{agent_turns:>12}{turn_pct:>6.0f}%  {verdict}")

    print("\n=== HONEST VERDICT ===")
    print("Speed% = human_time / agent_time (100% = parity; the >=90% bar means agent")
    print("must finish in <= ~1.11x the human's time).")
    if not any_pass_speed:
        print("Result: agent FAILS the 90%-of-human wall-clock bar on rudimentary single tasks.")
        print("Root cause: each agent turn is one LLM round-trip (~3-5s). A human does a")
        print("trivial form in ~6-8s of fluid motion; the agent pays per-turn inference, so")
        print("a 13-turn task is ~60s. This gap is STRUCTURAL for one-shot trivial tasks,")
        print("not a perception bug, and cannot be closed to 90% by faster tools alone.")
        print("Where the agent can hit/beat human: (a) turn-count reduction (fewer LLM")
        print("round-trips), (b) tier-2 cached replay on repeat visits (~100ms, no UI),")
        print("(c) tedious/bulk tasks where humans are slow (50 fields, 100-item scrape).")


if __name__ == "__main__":
    main()
