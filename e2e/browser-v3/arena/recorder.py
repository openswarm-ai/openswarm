"""Central data store for the MiniWoB arena: every arm, every task, every step, one place.

Everything any arm produces lands in ONE append-only JSONL so no arm can be scored by a different
book than another. Screenshots are written per step and referenced by path from the step record, so
a claim about what an agent saw can always be checked against the pixels it saw it in.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

ARENA_DIR = Path(__file__).resolve().parent
RESULTS_DIR = Path(os.environ.get("OSW_ARENA_RESULTS", ARENA_DIR / "data"))
SHOTS_DIR = RESULTS_DIR / "shots"


@dataclass
class StepRecord:
    """One agent turn: what it saw, what it chose, what that cost, what the page did about it."""

    step: int
    action: str = ""
    # Accessible name(s) of the element(s) the action targeted, resolved at act time. Added after
    # a 6-part CompWoB loss read as 8 anonymous clicks -- a trace nobody can diagnose is data lost.
    target: str = ""
    action_ms: float = 0.0
    perceive_ms: float = 0.0
    think_ms: float = 0.0
    axtree_chars: int = 0
    axtree_nodes: int = 0
    dom_chars: int = 0
    n_interactive: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    reward: float = 0.0
    url: str = ""
    focused_bid: str = ""
    action_error: str = ""
    llm_error: str = ""
    retries: int = 0
    shot: str = ""
    # 1 when a screenshot rode along on this step's LLM call (the adaptive-vision cost metric).
    vision: int = 0


@dataclass
class EpisodeRecord:
    """One (arm, task, seed) attempt, scored by MiniWoB itself rather than by this file."""

    arm: str
    task: str
    seed: int
    model: str = ""
    reward: float = 0.0
    raw_reward: float = 0.0
    success: bool = False
    # reward >= 1.0: fully solved. `success` (reward>0) equals this on MiniWoB but on
    # checkpoint-scored benchmarks (WebArena-family) means only "partial credit" -- reports of
    # solve rates MUST use strict. Added after the 2026-08 mislabeling correction in ARENA.md.
    strict: bool = False
    # What the agent itself claimed; claimed and not success = a false success, the worst failure class.
    claimed_success: bool = False
    steps: int = 0
    wall_s: float = 0.0
    setup_s: float = 0.0
    first_action_s: float = 0.0
    terminated: bool = False
    truncated: bool = False
    error_class: str = ""
    error_detail: str = ""
    goal: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    llm_calls: int = 0
    started_at: float = 0.0
    step_records: list[StepRecord] = field(default_factory=list)

    def add(self, rec: StepRecord) -> None:
        self.step_records.append(rec)
        self.prompt_tokens += rec.prompt_tokens
        self.completion_tokens += rec.completion_tokens
        self.cost_usd += rec.cost_usd
        if rec.prompt_tokens or rec.completion_tokens or rec.think_ms:
            self.llm_calls += 1


class Recorder:
    """Append-only writer. One file per run tag, plus a stable `all.jsonl` that never gets rewritten."""

    def __init__(self, tag: str, run_id: str = "") -> None:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        SHOTS_DIR.mkdir(parents=True, exist_ok=True)
        self.tag = tag
        self.run_id = run_id or time.strftime("%Y%m%d-%H%M%S")
        self.path = RESULTS_DIR / f"{tag}.jsonl"
        self.all_path = RESULTS_DIR / "all.jsonl"

    def shot_path(self, arm: str, task: str, seed: int, step: int) -> Path:
        d = SHOTS_DIR / self.run_id / arm / f"{task}-s{seed}"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{step:02d}.png"

    def write(self, ep: EpisodeRecord) -> None:
        row = asdict(ep)
        row["run_id"] = self.run_id
        row["tag"] = self.tag
        line = json.dumps(row, separators=(",", ":")) + "\n"
        for p in (self.path, self.all_path):
            with open(p, "a") as fh:
                fh.write(line)


def save_screenshot(obs: dict[str, Any], dest: Path) -> str:
    """Persist a BrowserGym observation frame. Returns the path, or '' if the frame was unusable."""
    arr = obs.get("screenshot")
    if arr is None:
        return ""
    try:
        from PIL import Image  # imported lazily so a no-screenshot run needs no pillow

        Image.fromarray(arr).save(dest)
        return str(dest)
    except Exception:
        return ""


def load_episodes(tag: str = "all") -> list[dict[str, Any]]:
    """Read back every episode for a tag; the report module's only input."""
    p = RESULTS_DIR / f"{tag}.jsonl"
    if not p.exists():
        return []
    out: list[dict[str, Any]] = []
    with open(p) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out
