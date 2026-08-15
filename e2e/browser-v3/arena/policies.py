"""The two model-free arms: a naive flat-axtree matcher, and OpenSwarm's own perception + ladder.

Keeping both free arms in one file is deliberate — they differ ONLY in what they are allowed to see
and how they pick, so having them side by side makes the delta auditable. Any model arm has to beat
the better of these two to have earned its latency.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import perception
from ranking import RankItem, goal_keywords, rank_and_cap, render


@dataclass
class Decision:
    """What a policy chose plus everything worth recording about how it got there."""

    action: str
    n_interactive: int = 0
    note: str = ""
    perceive_ms: float = 0.0


def quoted(goal: str) -> list[str]:
    """MiniWoB names its target in quotes far more often than not; treat that as a strong hint."""
    return re.findall(r'"([^"]+)"', goal) + re.findall(r"'([^']*)'", goal)


def wants_typing(goal: str) -> bool:
    g = goal.lower()
    return any(k in g for k in ("enter", "type", "text", "password", "search", "fill", "write"))


@dataclass
class FlatPolicy:
    """Naive control: read the flat tree, click the first exact label match, else the first control.

    This is the shape a model-free agent gets from a plain accessibility dump with no ranking, no
    dedupe and no memory. It is the floor every other arm is measured against.
    """

    name: str = "flat"
    acted: set[str] = field(default_factory=set)

    def reset(self, goal: str) -> None:
        self.acted = set()

    def act(self, obs: dict[str, Any], goal: str) -> Decision:
        items = perception.interactives(obs)
        want = quoted(goal)
        for it in items:
            if any(w.lower() == it.name.lower() for w in want) and it.bid not in self.acted:
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(items), "exact-label")
        if wants_typing(goal):
            for it in items:
                if it.role in ("textbox", "searchbox"):
                    payload = want[0] if want else "hello"
                    return Decision(f'fill("{it.bid}", "{payload}")', len(items), "first-textbox")
        for it in items:
            if it.bid not in self.acted:
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(items), "first-control")
        return Decision("", len(items), "exhausted")


@dataclass
class OpenSwarmPolicy:
    """OpenSwarm's shipped perception (dedupe, goal-rank, cap, ctx, value, stable ids) plus our ladder.

    The ladder mirrors browser_send_script.py: fill the composer the goal points at, verify by reading
    the value back out of the tree, and only then submit. Clicks avoid repeats the way our `*` new
    marker lets the model avoid re-acting on an element it already touched.
    """

    name: str = "openswarm"
    acted: set[str] = field(default_factory=set)
    filled: dict[str, str] = field(default_factory=dict)
    prev_bids: set[str] = field(default_factory=set)
    last_render: str = ""

    def reset(self, goal: str) -> None:
        self.acted = set()
        self.filled = {}
        self.prev_bids = set()
        self.last_render = ""

    def look(self, obs: dict[str, Any], goal: str) -> tuple[list[RankItem], int, set[str]]:
        raw = perception.interactives(obs)
        shown, truncated = rank_and_cap(raw, goal=goal)
        new = {it.bid for it in shown} - self.prev_bids if self.prev_bids else set()
        self.prev_bids = {it.bid for it in shown}
        return shown, truncated, new

    def act(self, obs: dict[str, Any], goal: str) -> Decision:
        shown, truncated, new = self.look(obs, goal)
        self.last_render = render(shown, truncated, new)
        keywords = goal_keywords(goal)
        want = quoted(goal)
        payload = want[0] if want else ""

        # Fill first when the goal asks for text and the box does not already hold it (readback-verified).
        if wants_typing(goal) and payload:
            for it in shown:
                if it.role in ("textbox", "searchbox", "combobox"):
                    if payload.lower() in (it.value or "").lower():
                        continue
                    return Decision(f'fill("{it.bid}", "{payload}")', len(shown), "fill")

        # Exact label match on the quoted target, skipping anything already acted on.
        for it in shown:
            if any(w.lower() == it.name.lower() for w in want) and it.bid not in self.acted:
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(shown), "exact-label")

        # Submit once the composer holds the payload, which is how our scripted path closes a task.
        if payload and any(payload.lower() in (it.value or "").lower() for it in shown):
            for it in shown:
                if it.role == "button" and re.search(r"submit|ok|done|send|search", it.name, re.I):
                    if it.bid not in self.acted:
                        self.acted.add(it.bid)
                        return Decision(f'click("{it.bid}")', len(shown), "submit")

        # Goal-keyword substring match: the ranking already floated these, so take the first.
        for it in shown:
            if keywords and any(k in it.name.lower() for k in keywords) and it.bid not in self.acted:
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(shown), "keyword")

        for it in shown:
            if it.bid not in self.acted and it.role in ("button", "link", "checkbox", "tab", "option"):
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(shown), "role-fallback")
        for it in shown:
            if it.bid not in self.acted:
                self.acted.add(it.bid)
                return Decision(f'click("{it.bid}")', len(shown), "any")
        return Decision("", len(shown), "exhausted")


REGISTRY = {"flat": FlatPolicy, "openswarm": OpenSwarmPolicy}


def build(name: str, **kwargs: Any) -> Any:
    if name in REGISTRY:
        return REGISTRY[name]()
    import llm_policy  # imported lazily so the free arms never need a model lane configured

    # An arm suffixed '@<lane>' keeps its own data file (so a cross-model run never merges into the
    # Claude numbers) while building the identical policy config. Used when the Claude subscription
    # lane is exhausted and measurement continues on another subscription (e.g. gpt) as its own arm.
    base = name.split("@", 1)[0]
    return llm_policy.build(base, **kwargs)
