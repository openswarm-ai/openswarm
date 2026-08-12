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
A row marked `off` is below the fold -- acting on it scrolls it into view automatically, so use it
directly rather than scrolling blindly. `#k/n` is the row's position inside its repeated group, so
"the 2nd result/post/story" means the row marked #2/n.
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
    vision: int = 0


@dataclass
class LlmPolicy:
    """Shared model loop; subclasses supply the page view and the action translation."""

    name: str = "llm"
    model: str = "cc/claude-sonnet-4-6"
    endpoint: str = "http://localhost:20128"
    system: str = BU_SYSTEM
    history: list[str] = field(default_factory=list)
    max_history: int = 6
    max_tokens: int = 200
    # Claude-5 lanes REJECT temperature outright ("deprecated for this model") -- v17's first
    # launch 400-looped on it. None = omit the field; the decode-variance lever is simply
    # unavailable on these models, so variance must be attacked at the action layer instead.
    temperature: float | None = None

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

    def call(self, goal: str, page: str, image_b64: str = "") -> tuple[str, LlmDecision]:
        past = "\n".join(self.history[-self.max_history:]) or "(none yet)"
        user = f"GOAL: {goal}\n\nACTIONS YOU ALREADY TOOK:\n{past}\n\nPAGE:\n{page}\n\nYour single next action:"
        content: Any = user
        if image_b64:
            content = [{"type": "text", "text": user + "\n(A SCREENSHOT of the page is attached; use it for exact coordinates and to see state the text view cannot show.)"},
                       {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}}]
        t0 = time.time()
        d = LlmDecision(action="")
        text = ""
        # Retry transient router faults: a concurrent-sweep run lost 40% of its episodes to 502s that
        # were then booked as policy failures. Retries make the residue rare; the classifier below
        # books what remains as infra, never as skill.
        for attempt in range(3):
            try:
                payload = {
                    "model": self.model,
                    "messages": [{"role": "system", "content": self.system},
                                 {"role": "user", "content": content}],
                    "max_tokens": self.max_tokens,
                    "stream": False,  # the router streams by default; a single action needs no SSE
                }
                if self.temperature is not None:
                    payload["temperature"] = self.temperature
                resp = post_json(f"{self.endpoint}/v1/chat/completions", payload)
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
        self.last_view_hash = 0
        self.fastpath_used = set()
        self.row_names = {}
        self.row_roles = {}
        self.row_values = {}
        self.picker_done = False
        self.last_fill_row = 0
        self.last_fill_val = ""
        self.fill_retried = False
        self.mode = "standard"
        self.verified_once = False

    def view(self, obs: dict[str, Any], goal: str) -> tuple[str, int]:
        raw_items: list[RankItem] = perception.interactives(
            obs, include_clickable=self.clickable, attr_hints=self.hints,
            include_offscreen=self.offscreen)
        shown, truncated = rank_and_cap(raw_items, goal=goal)
        new = {it.bid for it in shown} - self.prev_bids if self.prev_bids else set()
        self.prev_bids = {it.bid for it in shown}
        self.index_to_bid = {i: it.bid for i, it in enumerate(shown, 1)}
        self.row_names = {i: it.name for i, it in enumerate(shown, 1)}
        self.row_roles = {i: it.role for i, it in enumerate(shown, 1)}
        self.row_values = {i: it.value or "" for i, it in enumerate(shown, 1)}
        self.last_new_bids = new
        if self.som:
            extra = obs.get("extra_element_properties") or {}
            self.row_boxes = {}
            for i, it in enumerate(shown, 1):
                bbox = (extra.get(it.bid) or {}).get("bbox")
                if bbox:
                    self.row_boxes[i] = tuple(bbox)
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
        # scroll deltas, mouse_*/keyboard_* coordinates, navigation URLs and chat answers carry no
        # element handles -- pass through untouched.
        if fn == "scroll" or fn.startswith(("mouse_", "keyboard_", "go")) or fn in (
                "send_msg_to_user", "report_infeasible"):
            return call
        # click(93, 234) is a coordinate click the model spelled wrong; book-flight looped four
        # turns on 'expected a string' before this rewrite existed.
        if fn in ("click", "dblclick") and re.fullmatch(r"\s*\d+\s*,\s*\d+\s*", argstr):
            return f"mouse_{fn}({argstr})"
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

    # v6: browser-use's loop-detection nudge, taken from their own logs ('Loop detection nudge
    # injected'). A model that repeats one no-effect action verbatim never breaks out on its own --
    # v5 lost email-inbox-nl-turk to eight identical scroll(0,3) calls.
    nudge_repeats: bool = False
    # v7a: several actions per model call (fill+fill+click as one turn) -- fewer calls is faster
    # AND stronger on multi-step tasks; browser-use ships the same.
    multi: bool = False
    # v7b: 'adaptive' attaches a screenshot ONLY when stuck or the goal reads spatial, so the easy
    # 4-second wins never pay the vision bill. 'always' is the ablation arm.
    vision: str = "off"
    last_view_hash: int = 0
    # v8: the product's scripted-path shape -- when the goal's quoted target is visible as exactly
    # one row, click it with NO model call. Kills the near-miss click that ends tab/section tasks
    # (a wrong 'dignissim' is terminal) and shaves a whole LLM round-trip off the win path.
    fastpath: bool = False
    fastpath_used: set[str] = field(default_factory=set)
    split_submit: bool = False

    def stuck_or_spatial(self, page: str, goal: str, step_had_error: bool) -> bool:
        h = hash(page)
        unchanged = h == self.last_view_hash and bool(self.history)
        self.last_view_hash = h
        return unchanged or step_had_error or bool(SPATIAL_HINTS.search(goal))

    def try_fastpath(self, goal: str) -> str:
        """Deterministic click when a quoted goal target is visible as exactly ONE row, once per name."""
        import re as re_

        from policies import quoted

        targets = [t for t in quoted(goal) if t and t not in self.fastpath_used]
        for want in targets:
            hits = [i for i, bid in self.index_to_bid.items()]
            matches = [i for i in hits if self.row_name(i).lower() == want.lower()]
            if len(matches) == 1 and not re_.search(r"enter|type|fill|password|text", goal.lower()):
                self.fastpath_used.add(want)
                return f"click({matches[0]})"
        return ""

    row_names: dict[int, str] = field(default_factory=dict)

    def row_name(self, index: int) -> str:
        return self.row_names.get(index, "")

    # v13: scripted drag. One-shot mouse_drag_and_drop fails HTML5 drag handlers that need to SEE
    # intermediate mouseover events; decompose into down -> stepped moves -> up.
    scripted_drag: bool = False
    # v13: deterministic autocomplete resolver -- after a fill, a NEW row whose name starts with the
    # typed text is the dropdown suggestion; click it without a model call. book-flight's whole
    # failure mode is the model re-typing instead of picking the suggestion.
    auto_complete: bool = False
    last_fill: str = ""
    last_new_bids: set[str] = field(default_factory=set)
    # v13: Set-of-Marks -- number the menu rows on the screenshot itself (Skyvern/SeeAct).
    som: bool = False
    row_boxes: dict[int, tuple[float, float, float, float]] = field(default_factory=dict)

    def decompose_drag(self, call: str) -> str:
        m = re.fullmatch(r"mouse_drag_and_drop\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)", call)
        if not m:
            return call
        x0, y0, x1, y1 = (float(v) for v in m.groups())
        steps = [f"mouse_down({x0:.0f}, {y0:.0f})"]
        for k in (0.25, 0.5, 0.75, 1.0):
            steps.append(f"mouse_move({x0 + (x1 - x0) * k:.0f}, {y0 + (y1 - y0) * k:.0f})")
        steps.append(f"mouse_up({x1:.0f}, {y1:.0f})")
        return "\n".join(steps)

    # v15: native picker rung -- convert the goal's time/date into the ISO form the input demands
    # and fill it whole; models poke the spinbuttons instead and lose.
    native_pickers: bool = False
    picker_done: bool = False
    row_roles: dict[int, str] = field(default_factory=dict)
    # v17a: mechanical fill-verify -- if the previous turn filled a row and the fresh look shows the
    # row WITHOUT that value, the fill silently failed (JS-heavy inputs eat programmatic fills);
    # re-issue it once before anything else. Feature-triggered: fires only on observed mismatch.
    fill_verify: bool = False
    last_fill_row: int = 0
    last_fill_val: str = ""
    fill_retried: bool = False

    def try_fill_verify(self) -> str:
        if not (self.fill_verify and self.last_fill_row and self.last_fill_val and not self.fill_retried):
            return ""
        row_val = ""
        # row_names carries names; values ride in the rendered view -- check the authoritative map
        i = self.last_fill_row
        name = self.row_names.get(i, "")
        if i in self.row_names and self.last_fill_val.lower() not in (self.row_values.get(i, "") or "").lower():
            self.fill_retried = True
            return f'fill({i}, "{self.last_fill_val}")'
        self.last_fill_row = 0
        return ""

    row_values: dict[int, str] = field(default_factory=dict)

    # v19: include below-the-fold rows (the action layer scrolls them into view).
    offscreen: bool = False

    # v18: ensemble dispatcher -- ONE agent, ONE episode, but the rung set is chosen per task from
    # page/goal FEATURES at first sight (never task names). The systematic cross-version wins were
    # mode-shaped: forms want strict per-field verification, canvases want eyes every turn, consoles
    # want keyboard primitives, feedback games want many tiny turns.
    dispatch: bool = False
    mode: str = "standard"

    def detect_mode(self, obs: dict[str, Any], goal: str) -> str:
        g = goal.lower()
        roles = list(self.row_roles.values())
        n_inputs = sum(1 for r in roles if r in ("textbox", "searchbox", "combobox", "spinbutton",
                                                 "listbox", "InputTime", "checkbox", "radio"))
        named = sum(1 for n in self.row_names.values() if n and not n.startswith("("))
        big_text = any(r == "textbox" for r in roles) and len(roles) <= 3
        if re.search(r"terminal|command|console|editor|delete the (word|line)", g) and big_text:
            return "console"
        if re.search(r"guess|higher|lower|hot|cold|until|keep (clicking|guessing)", g):
            return "game"
        if named <= 2 and any(r in ("image", "generic", "clickable") for r in roles) and re.search(
                r"circle|angle|line|midpoint|draw|shape|point|slider|color", g):
            return "geometry"
        if n_inputs >= 3 or re.search(r"book|order|purchase|fill (in|out)|form", g):
            return "form"
        return "standard"

    MODE_PROMPTS = {
        "form": "\nFORM MODE: complete ONE field per turn and confirm its value= stuck in the fresh look before the next; keep a checklist of every required field in your PLAN; submit only when every checklist item shows its value.",
        "geometry": "\nGEOMETRY MODE: use the screenshot every turn; estimate coordinates, act, then MEASURE the result in the next screenshot and correct; small moves beat big guesses.",
        "console": "\nCONSOLE MODE: click the text area once to focus, then use keyboard_type/keyboard_press for everything; re-read the text content after each command.",
        "game": "\nGAME MODE: one small action per turn; keep every guess and its feedback in your PLAN line; binary-search on numeric feedback.",
    }

    def apply_mode(self, obs: dict[str, Any], goal: str) -> None:
        if not self.dispatch or self.mode != "standard" or self.history:
            return
        m = self.detect_mode(obs, goal)
        self.mode = m
        if m == "geometry":
            self.vision = "always"
            self.multi = False
        elif m == "game":
            self.multi = False
            self.max_tokens = 250
        elif m == "form":
            self.multi_cap = 2  # one-two verified steps per turn; no gambled 6-chains
        if m in self.MODE_PROMPTS:
            self.system = self.system + self.MODE_PROMPTS[m]

    # v16a: one verification call before the episode's first terminal-looking click -- the measured
    # variance killer (same task passes/fails run to run on a premature submit).
    verify_terminal: bool = False
    verified_once: bool = False
    # v16b: any mouse_* geometry action forces eyes on the NEXT turn (look-act-look-again).
    post_mouse_vision: bool = False
    # v16c: rapid-fire cap -- more, cheaper actions per turn for feedback-loop tasks.
    multi_cap: int = 3

    def try_native_picker(self, goal: str) -> str:
        if not self.native_pickers or self.picker_done:
            return ""
        for i, name in self.row_names.items():
            low = name.lower()
            role = self.row_roles.get(i, "").lower()
            if role == "inputtime" or "(tt)" in low:
                m = re.search(r"(\d{1,2}):(\d{2})\s*(am|pm)?", goal, re.I)
                if m:
                    h, mnt, ap = int(m.group(1)), m.group(2), (m.group(3) or "").lower()
                    if ap == "pm" and h != 12:
                        h += 12
                    if ap == "am" and h == 12:
                        h = 0
                    self.picker_done = True
                    return f'fill({i}, "{h:02d}:{mnt}")'
            if role in ("inputdate", "date") or "datepicker" in low or low == "(date)":
                m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", goal)
                if m:
                    mo, dy, yr = m.groups()
                    self.picker_done = True
                    return f'fill({i}, "{yr}-{int(mo):02d}-{int(dy):02d}")'
        return ""

    def try_autocomplete(self, new_bids: set[str]) -> str:
        """Click the fresh dropdown row matching the last fill's text; '' when no clean match.

        One attempt per fill: the intent is only live on the turn right after typing -- a stale
        fill grabbing some unrelated new row two turns later would be worse than no primitive.
        """
        if not (self.auto_complete and self.last_fill and new_bids):
            self.last_fill = ""
            return ""
        want, self.last_fill = self.last_fill.lower(), ""
        matches = [i for i, name in self.row_names.items()
                   if self.index_to_bid.get(i) in new_bids
                   and name and (name.lower().startswith(want) or want in name.lower())]
        if len(matches) == 1:
            return f"click({matches[0]})"
        return ""

    def act(self, obs: dict[str, Any], goal: str) -> LlmDecision:
        page, n = self.view(obs, goal)
        self.apply_mode(obs, goal)
        fv = self.try_fill_verify()
        if fv:
            d = LlmDecision(action=self.translate(fv), n_interactive=n, note="fill-verify-retry")
            self.note(fv + "  (mechanical fill retry: value did not stick)", obs)
            return d
        pk = self.try_native_picker(goal)
        if pk:
            d = LlmDecision(action=self.translate(pk), n_interactive=n, note="native-picker")
            self.note(pk + "  (scripted native picker)", obs)
            return d
        ac = self.try_autocomplete(self.last_new_bids)
        if ac:
            d = LlmDecision(action=self.translate(ac), n_interactive=n, note="autocomplete")
            self.note(ac + "  (scripted autocomplete pick)", obs)
            return d
        if self.fastpath:
            fp = self.try_fastpath(goal)
            if fp:
                d = LlmDecision(action=self.translate(fp), n_interactive=n, note="fastpath")
                self.note(fp + "  (scripted exact-match)", obs)
                return d
        last_err = bool(str(obs.get("last_action_error") or "").strip())
        image = ""
        # progressive: adaptive triggers PLUS any task that has already burned 6 actions gets eyes
        # every turn -- a dragging episode is by definition one the text view is not solving.
        struggling = self.vision == "progressive" and len(self.history) >= 6
        after_mouse = (self.post_mouse_vision and self.history
                       and self.history[-1].startswith("mouse_"))
        if (self.vision == "always"
                or (self.vision in ("adaptive", "progressive")
                    and (self.stuck_or_spatial(page, goal, last_err) or struggling or after_mouse))):
            image = encode_screenshot(obs, marks=self.row_boxes if self.som else None)
        raw, d = self.call(goal, page, image_b64=image)
        d.vision = 1 if image else 0
        chosen_list = clean_actions(raw, limit=self.multi_cap) if self.multi else [clean_action(raw)]
        chosen_list = [c for c in chosen_list if c]
        # Verify-then-send chain split, GATED: measured net-negative on the full sweep (v11 70.5%
        # vs v10 75.2%) -- the extra look costs more than the gamble it prevents. Kept for study.
        if self.split_submit:
            for i, c in enumerate(chosen_list[1:], 1):
                idx_m = re.match(r"click\((\d+)", c)
                if idx_m and re.search(r"submit|send|ok\b|done", self.row_name(int(idx_m.group(1))), re.I):
                    chosen_list = chosen_list[:i]
                    break
        if (self.nudge_repeats and len(chosen_list) == 1 and self.history
                and self.history[-1].startswith(chosen_list[0] + " ->")):
            self.history.append(f"{chosen_list[0]} -> REPEATED with no progress; that approach is exhausted, pick a different element or action type")
            raw, d2 = self.call(goal, page, image_b64=image)
            d.prompt_tokens += d2.prompt_tokens
            d.completion_tokens += d2.completion_tokens
            d.think_ms += d2.think_ms
            retry = [c for c in (clean_actions(raw) if self.multi else [clean_action(raw)]) if c]
            chosen_list = retry or chosen_list
        # One verification round before the first terminal-looking click of the episode.
        if (self.verify_terminal and not self.verified_once and chosen_list):
            last = chosen_list[-1]
            m_sub = re.match(r"click\((\d+)", last)
            if m_sub and re.search(r"submit|send|done|ok\b", self.row_name(int(m_sub.group(1))), re.I):
                self.verified_once = True
                self.history.append(f"{last} -> HOLD: before this final click, re-check EVERY part of the goal against the page; reply the SAME action to confirm, or the corrective actions instead")
                raw2, d2 = self.call(goal, page, image_b64=image or encode_screenshot(obs))
                # The HOLD prompt is for THIS call only; leaving it in history poisons every later
                # turn with a stale instruction the model keeps trying to obey.
                self.history.pop()
                d.prompt_tokens += d2.prompt_tokens
                d.completion_tokens += d2.completion_tokens
                d.think_ms += d2.think_ms
                redo = [c for c in clean_actions(raw2, limit=self.multi_cap) if c]
                if redo:
                    chosen_list = redo
        d.n_interactive = n
        translated = [self.translate(c) for c in chosen_list]
        if self.scripted_drag:
            translated = [self.decompose_drag(t) for t in translated]
        d.action = "\n".join(translated)
        for c in chosen_list:
            self.note(c, obs)
            fm = re.match(r'fill\(\s*(\d+)\s*,\s*"([^"]+)"', c)
            if fm:
                self.last_fill = fm.group(2)
                self.last_fill_row = int(fm.group(1))
                self.last_fill_val = fm.group(2)
                self.fill_retried = False
        return d


# v5's addition, kept as its own constant so a supervisor restart never mutates v4 mid-sweep:
# browser-use's eval-memory loop won 35 multi-step tasks against v3's click-a-near-miss habit.
OSW_SYSTEM_V5 = OSW_SYSTEM + """
Reply with your action call(s) FIRST, each on its own line. AFTER them you may add one line:
PLAN: <what is done, what remains, what to check next>. Never put anything before the first action. If the goal names a target you cannot see in the list or the page
text, EXPLORE first (switch tabs, scroll, open sections) -- never act on a near-miss. Before any
final submit/done click, re-check that every part of the goal is satisfied."""

# v7: multi-action turns + occasional screenshots. Own constant for the same restart-safety reason.
OSW_SYSTEM_V7 = OSW_SYSTEM_V5 + """
You may output UP TO 3 actions, one per line, executed in order (e.g. two fills then the submit
click). Only chain actions whose targets are already visible; after anything that changes the page
(tab switch, open, search), STOP the chain there and look again next turn.
When a screenshot is attached, trust it over the text for geometry: pick exact mouse_click(x, y)
coordinates from what you see."""

# v15: widget discipline for the never-solved cluster -- native pickers, per-item flows, pagination.
OSW_SYSTEM_V9_WIDGETS = """
Native date inputs: fill(index, "YYYY-MM-DD"). Native time inputs: fill(index, "HH:MM") in 24-hour
time. Never poke spinbuttons when the parent input can be filled whole.
Multi-item goals ("all items matching X"): list every target in your PLAN line, mark each done as
you go, and re-check the list before submitting -- missing one item scores zero.
If a named search result is not on this page, click the next page number and keep looking."""

OSW_SYSTEM_V16 = """
After every sub-step of a form, confirm the value stuck (check value= in the fresh list) before
moving on. In guess-and-check tasks (hot/cold, higher/lower), act FAST: one short action per turn,
keep the running state in your PLAN line, no deliberation. Before any final submit, re-check every
requirement of the goal against the page."""

# v8: the exact-name discipline the tab/section losses demanded -- a wrong click on a goal-named
# link is TERMINAL on these tasks, so a near-miss is worse than another exploration step.
OSW_SYSTEM_V8 = OSW_SYSTEM_V7 + """
When the goal names an exact target in quotes: click ONLY an element whose name matches it EXACTLY.
If no exact match is visible yet, do not settle for a similar one -- open the next unexplored tab or
section (track which you have tried in your PLAN line) until the exact name appears.
On the open web you may also navigate: goto("url") | go_back() | go_forward().
When the goal is a QUESTION, research it and deliver the answer with send_msg_to_user("answer") --
the answer text alone, no prose around it."""

CALL_RE = re.compile(
    r"\b(click|dblclick|fill|clear|select_option|hover|focus|press|scroll|drag_and_drop|noop"
    r"|mouse_click|mouse_dblclick|mouse_move|mouse_drag_and_drop|keyboard_type|keyboard_press"
    r"|goto|go_back|go_forward|send_msg_to_user|report_infeasible)\s*\([^)]*\)")


def clean_action(raw: str) -> str:
    """Pull the one action call out of whatever the model wrapped it in; empty means unparseable."""
    if not raw:
        return ""
    text = raw.strip().strip("`")
    text = re.sub(r"^(python|json|tool_code)\s*", "", text)
    m = CALL_RE.search(text)
    return m.group(0) if m else ""


def clean_actions(raw: str, limit: int = 3) -> list[str]:
    """All action calls in the reply, in order, capped -- the multi-action variant of clean_action."""
    if not raw:
        return []
    text = raw.strip().strip("`")
    text = re.sub(r"^(python|json|tool_code)\s*", "", text)
    return [m.group(0) for m in CALL_RE.finditer(text)][:limit]


SPATIAL_HINTS = re.compile(r"circle|angle|midpoint|draw|drag|shape|slider|point|pie|line|grid|color\b", re.I)


def encode_screenshot(obs: dict[str, Any], max_w: int = 720,
                      marks: dict[int, tuple[float, float, float, float]] | None = None) -> str:
    """Downscaled PNG of the current frame; small pages stay small so vision stays cheap.

    marks is Set-of-Marks (Skyvern/SeeAct): draw each menu row's index on its box, so the text
    list and the pixels share one address space and 'the third link' stops being a guess.
    """
    arr = obs.get("screenshot")
    if arr is None:
        return ""
    try:
        import base64
        import io

        from PIL import Image, ImageDraw

        img = Image.fromarray(arr)
        if marks:
            draw = ImageDraw.Draw(img)
            for idx, (x, y, w, h) in marks.items():
                draw.rectangle([x, y, x + w, y + h], outline=(220, 30, 30), width=2)
                draw.rectangle([x, y - 12, x + 8 * len(str(idx)) + 6, y], fill=(220, 30, 30))
                draw.text((x + 3, y - 12), str(idx), fill=(255, 255, 255))
        if img.width > max_w:
            img = img.resize((max_w, int(img.height * max_w / img.width)))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


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
    if name == "osw-llm-v5":
        return OpenSwarmLlmPolicy(name=name, model=model, endpoint=endpoint, clickable=True,
                                  with_text=True, hints=True, system=OSW_SYSTEM_V5, max_history=12, max_tokens=350)
    if name == "osw-llm-v6":
        return OpenSwarmLlmPolicy(name=name, model=model, endpoint=endpoint, clickable=True,
                                  with_text=True, hints=True, system=OSW_SYSTEM_V5, max_history=12,
                                  max_tokens=350, nudge_repeats=True)
    # v7 family: ablatable primitives on top of v5 (the champion base).
    v7 = dict(model=model, endpoint=endpoint, clickable=True, with_text=True, hints=True,
              system=OSW_SYSTEM_V7, max_history=12, max_tokens=400, nudge_repeats=True)
    if name == "osw-llm-v7":
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="adaptive", **v7)
    if name == "osw-llm-v7m":  # multi-action only (vision ablated)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="off", **v7)
    if name == "osw-llm-v7v":  # adaptive vision only (multi ablated)
        return OpenSwarmLlmPolicy(name=name, multi=False, vision="adaptive", **v7)
    if name == "osw-llm-v8":
        v8 = dict(v7, system=OSW_SYSTEM_V8)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="adaptive", fastpath=True, **v8)
    if name == "osw-llm-v9":  # v8 + progressive vision; run with --max-steps 24 (21 losses were step-capped)
        v9 = dict(v7, system=OSW_SYSTEM_V8)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True, **v9)
    if name == "osw-llm-v10":  # v9 + subtree-text name resolution (the '(alink)' fix); same flags
        v10 = dict(v7, system=OSW_SYSTEM_V8)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True, **v10)
    if name == "osw-llm-v11":  # v10 + coord-click rewrite + submit-chain split + untruncated payloads
        v11 = dict(v7, system=OSW_SYSTEM_V8, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  split_submit=True, **v11)
    if name == "osw-llm-v12":  # v10 exactly, chain-split off; run with --max-steps 36 for the long forms
        v12 = dict(v7, system=OSW_SYSTEM_V8, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True, **v12)
    if name == "osw-llm-v13":  # v10 + scripted drag + autocomplete resolver + Set-of-Marks vision
        v13 = dict(v7, system=OSW_SYSTEM_V8, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=True, **v13)
    if name == "osw-llm-v14":  # v13 autopsy verdict: keep autocomplete + drag, DROP SoM (occludes micro-UIs)
        v14 = dict(v7, system=OSW_SYSTEM_V8, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False, **v14)
    if name == "osw-llm-v15":  # v14 + native picker rung + widget/per-item/pagination discipline
        v15 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, **v15)
    if name == "osw-llm-v17":  # v16 + temp0 + mechanical fill-verify; all rungs feature-gated
        v17 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, fill_verify=True, **v17)
    if name == "osw-llm-v22":  # STRUCTURAL truncation fix: action-first reply order (class impossible)
        v22 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=800)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, fill_verify=True, dispatch=True, offscreen=True, **v22)
    if name == "osw-llm-v21":  # v20 + bare-prompt retry (the 7 residual truncation deaths)
        v21 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=800)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, fill_verify=True, dispatch=True, offscreen=True, **v21)
    if name == "osw-llm-v20":  # v19 + strict-retry on unparseable replies + 800-token headroom
        v20 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=800)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, fill_verify=True, dispatch=True, offscreen=True, **v20)
    if name in ("osw-llm-v18", "osw-llm-v19"):  # v18 + (v19) off-screen rows and group ordinals
        v18 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, fill_verify=True, dispatch=True,
                                  offscreen=(name == "osw-llm-v19"), **v18)
    if name == "osw-llm-v16":  # v15 + verify-terminal + look-act-look + rapid-fire cap
        v16 = dict(v7, system=OSW_SYSTEM_V8 + OSW_SYSTEM_V9_WIDGETS + OSW_SYSTEM_V16, max_tokens=500)
        return OpenSwarmLlmPolicy(name=name, multi=True, vision="progressive", fastpath=True,
                                  scripted_drag=True, auto_complete=True, som=False,
                                  native_pickers=True, verify_terminal=True, post_mouse_vision=True,
                                  multi_cap=6, **v16)
    raise SystemExit(f"unknown arm: {name}")
