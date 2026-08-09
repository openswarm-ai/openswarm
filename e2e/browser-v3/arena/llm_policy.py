"""Model-driven arms. Same model, same steps, same action space, same scorer -- only the page view differs.

That constraint is the entire experiment. `bu` renders the page the way browser-use does (flat
accessibility dump, every node, no memory between turns); `osw` renders it the way OpenSwarm's
BrowserListInteractives does (deduped, goal-ranked, capped at 60, ctx on twins, value on inputs,
`*` on anything new since the last look). Any score gap between them is attributable to that view.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import perception
from policies import Decision
from ranking import RankItem, rank_and_cap, render

ACTIONS = """click(bid) | dblclick(bid) | fill(bid, "text") | clear(bid) | select_option(bid, "opt")
hover(bid) | focus(bid) | press(bid, "key") | scroll(dx, dy) | drag_and_drop(from_bid, to_bid)
mouse_click(x, y) | mouse_drag_and_drop(from_x, from_y, to_x, to_y)  (viewport coordinates)"""

BU_SYSTEM = """You are a web agent. You are given the accessibility tree of a page and a goal.
Respond with EXACTLY ONE action call and nothing else. No prose, no markdown, no explanation.
Available actions:
""" + ACTIONS

OSW_SYSTEM = """You are OpenSwarm's browser agent. You see a ranked, deduplicated list of the page's
interactive elements. Each row is [index]<role "name" value="...">. A `*` means the element is new
since your last look; the same index always means the same element. Rows without a useful name show
center=(x,y) viewport coordinates.
Respond with EXACTLY ONE action call and nothing else. No prose, no markdown, no explanation.
Available actions, addressing elements by their [index]:
click(index) | fill(index, "text") | select_option(index, "opt") | press(index, "key")
clear(index) | hover(index) | focus(index) | scroll(dx, dy) | drag_and_drop(from_index, to_index)
For targets with no element of their own (a spot on a canvas, a slider position), use coordinates:
mouse_click(x, y) | mouse_dblclick(x, y) | mouse_drag_and_drop(from_x, from_y, to_x, to_y)
For a combobox/listbox row showing options="...", pick with select_option(index, "exact option").
Prefer filling the box the goal names, then submitting. Do not repeat an action that already worked.
If an action did not change the page, try a DIFFERENT action, never the same one again."""


def post_json(url: str, payload: dict[str, Any], timeout: float = 90.0) -> dict[str, Any]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer arena"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


@dataclass
class LlmDecision(Decision):
    """Decision plus the per-call accounting the recorder folds into episode totals."""

    think_ms: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    llm_error: str = ""
    retries: int = 0


@dataclass
class LlmPolicy:
    """Shared model loop; subclasses supply the page view and the action translation."""

    name: str = "llm"
    model: str = "cc/claude-sonnet-4-6"
    endpoint: str = "http://localhost:20128"
    system: str = BU_SYSTEM
    history: list[str] = field(default_factory=list)
    max_history: int = 6

    def reset(self, goal: str) -> None:
        self.history = []

    def view(self, obs: dict[str, Any], goal: str) -> tuple[str, int]:
        raise NotImplementedError

    def translate(self, raw: str) -> str:
        return raw

    def note(self, action: str, obs: dict[str, Any]) -> None:
        """History is kept in the MODEL's own namespace, with the outcome the page reported.

        The first version logged the translated bid call, so the OpenSwarm arm was shown history it
        could not line up against the indices in its own element list and re-clicked the same box
        five times. Feeding an agent a memory it cannot read is a harness bug, not an agent failure.
        """
        err = str(obs.get("last_action_error") or "").strip()
        self.history.append(f"{action} -> {'ERROR: ' + err[:120] if err else 'ok'}")

    def call(self, goal: str, page: str) -> tuple[str, LlmDecision]:
        past = "\n".join(self.history[-self.max_history:]) or "(none yet)"
        user = f"GOAL: {goal}\n\nACTIONS YOU ALREADY TOOK:\n{past}\n\nPAGE:\n{page}\n\nYour single next action:"
        t0 = time.time()
        d = LlmDecision(action="")
        text = ""
        # Retry transient router faults: a concurrent-sweep run lost 40% of its episodes to 502s that
        # were then booked as policy failures. Retries make the residue rare; the classifier below
        # books what remains as infra, never as skill.
        for attempt in range(3):
            try:
                resp = post_json(f"{self.endpoint}/v1/chat/completions", {
                    "model": self.model,
                    "messages": [{"role": "system", "content": self.system},
                                 {"role": "user", "content": user}],
                    "max_tokens": 200,
                    "stream": False,  # the router streams by default; a single action needs no SSE
                })
                text = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                usage = resp.get("usage") or {}
                d.prompt_tokens = int(usage.get("prompt_tokens") or 0)
                d.completion_tokens = int(usage.get("completion_tokens") or 0)
                d.llm_error = ""
                d.retries = attempt
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as exc:
                d.llm_error = f"{type(exc).__name__}: {exc}"[:150]
                time.sleep(2.0 * (attempt + 1))
        d.think_ms = (time.time() - t0) * 1000
        return str(text).strip(), d


@dataclass
class BrowserUseStylePolicy(LlmPolicy):
    """Flat accessibility dump, exactly what a browser-use-shaped agent puts in front of a model."""

    name: str = "bu"
    system: str = BU_SYSTEM

    def view(self, obs: dict[str, Any], goal: str) -> tuple[str, int]:
        from browsergym.utils.obs import flatten_axtree_to_str

        text = flatten_axtree_to_str(obs.get("axtree_object") or {})
        n = len(perception.interactives(obs))
        return text[:14000], n

    def act(self, obs: dict[str, Any], goal: str) -> LlmDecision:
        page, n = self.view(obs, goal)
        raw, d = self.call(goal, page)
        d.n_interactive = n
        d.action = clean_action(raw)
        if d.action:
            self.note(d.action, obs)
        return d


@dataclass
class OpenSwarmLlmPolicy(LlmPolicy):
    """OpenSwarm's ranked element menu, addressed by stable 1-based index instead of raw bid."""

    name: str = "osw-llm"
    system: str = OSW_SYSTEM
    index_to_bid: dict[int, str] = field(default_factory=dict)
    prev_bids: set[str] = field(default_factory=set)
    # v2: also list clickable-but-unroled elements (canvas/svg/div) -- ingested from browser-use.
    clickable: bool = False
    # v3: append the page's visible text, our BrowserGetText equivalent; menu-only lost every task
    # whose payload lives in prose (the algebra equation, which email is Cecile's).
    with_text: bool = False
    # v4: DOM attribute names for nameless rows ('(trash)') -- the last piece the email suite needed.
    hints: bool = False

    def reset(self, goal: str) -> None:
        self.history = []
        self.index_to_bid = {}
        self.prev_bids = set()

    def view(self, obs: dict[str, Any], goal: str) -> tuple[str, int]:
        raw_items: list[RankItem] = perception.interactives(
            obs, include_clickable=self.clickable, attr_hints=self.hints)
        shown, truncated = rank_and_cap(raw_items, goal=goal)
        new = {it.bid for it in shown} - self.prev_bids if self.prev_bids else set()
        self.prev_bids = {it.bid for it in shown}
        self.index_to_bid = {i: it.bid for i, it in enumerate(shown, 1)}
        view = render(shown, truncated, new)
        if self.with_text:
            text = perception.page_text(obs)
            if text:
                view += f"\n\nPAGE TEXT:\n{text}"
        return view, len(shown)

    def translate(self, call: str) -> str:
        """Swap our 1-based indices back to bids so both arms hit the identical action layer."""
        m = re.match(r"(\w+)\s*\((.*)\)\s*$", call, re.S)
        if not m:
            return call
        fn, argstr = m.group(1), m.group(2)
        # scroll deltas and mouse_*/keyboard_* coordinates are geometry, never element handles.
        if fn == "scroll" or fn.startswith(("mouse_", "keyboard_")):
            return call
        # Only leading positional args are element handles, so rewrite those and leave payloads alone.
        # Quoted digits count too: the model addresses indices, so click("3") means row 3, never bid 3.
        n_handles = 2 if fn == "drag_and_drop" else 1
        parts = [a.strip() for a in re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', argstr)] if argstr.strip() else []
        for i in range(min(n_handles, len(parts))):
            m2 = re.fullmatch(r'"?(\d+)"?', parts[i])
            if m2:
                bid = self.index_to_bid.get(int(m2.group(1)))
                if bid:
                    parts[i] = f'"{bid}"'
        return f"{fn}({', '.join(parts)})"

    def act(self, obs: dict[str, Any], goal: str) -> LlmDecision:
        page, n = self.view(obs, goal)
        raw, d = self.call(goal, page)
        d.n_interactive = n
        chosen = clean_action(raw)
        d.action = self.translate(chosen)
        if chosen:
            self.note(chosen, obs)
        return d


CALL_RE = re.compile(
    r"\b(click|dblclick|fill|clear|select_option|hover|focus|press|scroll|drag_and_drop|noop"
    r"|mouse_click|mouse_dblclick|mouse_move|mouse_drag_and_drop|keyboard_type|keyboard_press)\s*\([^)]*\)")


def clean_action(raw: str) -> str:
    """Pull the one action call out of whatever the model wrapped it in; empty means unparseable."""
    if not raw:
        return ""
    text = raw.strip().strip("`")
    text = re.sub(r"^(python|json|tool_code)\s*", "", text)
    m = CALL_RE.search(text)
    return m.group(0) if m else ""


def build(name: str, model: str = "", endpoint: str = "", **_: Any) -> Any:
    model = model or os.environ.get("OSW_ARENA_MODEL", "cc/claude-sonnet-4-6")
    endpoint = endpoint or os.environ.get("OSW_ARENA_ENDPOINT", "http://localhost:20128")
    if name in ("bu", "bu-llm", "browseruse-style"):
        return BrowserUseStylePolicy(model=model, endpoint=endpoint)
    if name in ("osw-llm", "openswarm-llm"):
        return OpenSwarmLlmPolicy(model=model, endpoint=endpoint)
    if name == "osw-llm-v2":
        return OpenSwarmLlmPolicy(name=name, model=model, endpoint=endpoint, clickable=True)
    if name == "osw-llm-v3":
        return OpenSwarmLlmPolicy(name=name, model=model, endpoint=endpoint,
                                  clickable=True, with_text=True)
    if name == "osw-llm-v4":
        return OpenSwarmLlmPolicy(name=name, model=model, endpoint=endpoint,
                                  clickable=True, with_text=True, hints=True)
    raise SystemExit(f"unknown arm: {name}")
