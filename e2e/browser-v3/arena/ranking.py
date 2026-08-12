"""Port of frontend/src/shared/interactiveRanking.ts, so the arena scores OUR algorithm, not a sketch of it.

Kept deliberately line-for-line with the TypeScript: same roles, same priorities, same stopwords,
same cap, same doc-order display. If this drifts from the product the arena stops measuring the
product, so any change here should land in interactiveRanking.ts too (and vice versa).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# CDP computed roles we treat as actionable, from browserCommandHandler.ts INTERACTIVE_ROLES.
INTERACTIVE_ROLES = {
    "button", "link", "textbox", "combobox", "checkbox", "menuitem",
    "tab", "switch", "searchbox", "slider", "listbox", "option",
    "radio", "menuitemcheckbox", "menuitemradio", "spinbutton", "treeitem",
}

# Lower = higher priority: things a user types into, then navigation, then toggles, then the tail.
ROLE_PRIORITY = {
    "textbox": 0, "searchbox": 0, "combobox": 0,
    "button": 1, "link": 1, "menuitem": 1, "tab": 1,
    "checkbox": 2, "radio": 2, "switch": 2, "menuitemcheckbox": 2, "menuitemradio": 2,
    "option": 3, "treeitem": 3, "listbox": 3, "slider": 3, "spinbutton": 3,
}
DEFAULT_PRIORITY = 2
DEFAULT_INTERACTIVE_CAP = 60

STOPWORDS = {
    "the", "and", "for", "with", "click", "type", "into", "button", "link",
    "press", "select", "open", "goto", "navigate", "find", "tap", "this",
    "that", "your", "from", "page", "then", "enter", "input", "field", "box",
    "icon", "menu", "option", "item", "element",
}


@dataclass
class RankItem:
    """One interactive node. `bid` is BrowserGym's handle, standing in for our backendNodeId."""

    role: str
    name: str
    bid: str
    value: str = ""
    context: str = ""
    # Viewport center, for rows the model may need to hit by coordinate (canvas, slider track).
    center: tuple[float, float] | None = None
    # Child option labels for combobox/listbox rows; without them a closed <select> is unactionable.
    options: list[str] | None = None
    # Rendered but outside the viewport. The action layer scrolls into view automatically, so these
    # are perfectly actionable -- hiding them made every long feed unsolvable (the @ashlea row the
    # goal named was simply absent from the menu).
    offscreen: bool = False


def role_priority(role: str) -> int:
    return ROLE_PRIORITY.get(role, DEFAULT_PRIORITY)


def goal_keywords(goal: str) -> list[str]:
    words = [w for w in re.split(r"[^a-z0-9]+", goal.lower()) if w]
    kept = [w for w in words if len(w) >= 3 and w not in STOPWORDS]
    seen: list[str] = []
    for w in kept:
        if w not in seen:
            seen.append(w)
    return seen[:8]


def matches_goal(name: str, keywords: list[str]) -> bool:
    if not keywords:
        return False
    lower = name.lower()
    return any(k in lower for k in keywords)


# Roles whose twins are individually meaningful: two same-named password boxes are two fields the
# user must both fill, never an icon+label pair. Collapsing them cost enter-password outright.
NEVER_DEDUPE_ROLES = {"textbox", "searchbox", "combobox", "spinbutton", "listbox"}


def dedupe_consecutive(items: list[RankItem]) -> list[RankItem]:
    """Collapse only BACK-TO-BACK role+name+context twins, so a genuine list of five is never merged."""
    out: list[RankItem] = []
    for it in items:
        prev = out[-1] if out else None
        # Nameless rows are also exempt: two adjacent unlabeled icons (star, trash) look identical
        # by role+name+context yet are different controls -- collapsing them lost the email suite.
        if (prev and prev.role == it.role and prev.name == it.name and prev.context == it.context
                and it.role not in NEVER_DEDUPE_ROLES and it.name):
            continue
        out.append(it)
    return out


def rank_and_cap(items: list[RankItem], goal: str = "", cap: int = DEFAULT_INTERACTIVE_CAP,
                 doc_order: bool = True) -> tuple[list[RankItem], int]:
    """Rank decides WHAT survives the cap; display order stays document order so ordinals read true."""
    keywords = goal_keywords(goal) if goal else []
    deduped = dedupe_consecutive(items)
    scored = [(it, i, 0 if matches_goal(it.name, keywords) else 1) for i, it in enumerate(deduped)]
    ranked = sorted(scored, key=lambda x: (x[2], role_priority(x[0].role), x[1]))
    selected = ranked[:cap] if cap > 0 else ranked
    displayed = sorted(selected, key=lambda x: x[1]) if doc_order else selected
    return [x[0] for x in displayed], max(0, len(ranked) - len(displayed))


def render(items: list[RankItem], truncated: int, new_bids: set[str] | None = None) -> str:
    """The exact string shape BrowserListInteractives hands the model, including the * new-marker."""
    if not items:
        return "No interactive elements found on this page."
    counts: dict[str, int] = {}
    for el in items:
        k = f"{el.role}|{el.name}"
        counts[k] = counts.get(k, 0) + 1
    # Ordinals inside repeated structures: search results, feed posts, product cards. Counting is
    # what goals mean by "the 2nd result"; without it the model guesses among interleaved links.
    ordinals: dict[int, str] = {}
    by_name: dict[str, list[int]] = {}
    for i, el in enumerate(items, 1):
        by_name.setdefault(f"{el.role}|{el.name}", []).append(i)
    for key, idxs in by_name.items():
        if len(idxs) > 1:
            for k, i in enumerate(idxs, 1):
                ordinals[i] = f" #{k}/{len(idxs)}"
    run_start, run_role = 0, None
    runs: list[tuple[int, int, str]] = []
    for i, el in enumerate(items, 1):
        if el.role != run_role:
            if run_role is not None and i - run_start >= 3:
                runs.append((run_start, i - 1, run_role))
            run_start, run_role = i, el.role
    if run_role is not None and len(items) + 1 - run_start >= 3:
        runs.append((run_start, len(items), run_role))
    for a, b, _role in runs:
        for k, i in enumerate(range(a, b + 1), 1):
            ordinals.setdefault(i, f" #{k}/{b - a + 1}")

    lines = []
    for i, el in enumerate(items, 1):
        dup = counts.get(f"{el.role}|{el.name}", 0) > 1
        # ctx also whenever the name alone cannot identify the row (empty or a bare attr hint).
        weak_name = not el.name or el.name.startswith("(")
        ctx = f' ctx="{el.context}"' if (dup or weak_name) and el.context else ""
        val = f' value="{el.value}"' if el.value else ""
        star = "*" if new_bids and el.bid in new_bids else ""
        off = " off" if el.offscreen else ""
        # Coordinates whenever the label alone cannot pin the row; a named button needs no geometry.
        pos = f" center=({el.center[0]:.0f},{el.center[1]:.0f})" if el.center and weak_name else ""
        opts = ""
        if el.options:
            shown_opts = el.options[:12]
            more = f" +{len(el.options) - 12}" if len(el.options) > 12 else ""
            opts = f' options="{"|".join(shown_opts)}{more}"'
        ordinal = ordinals.get(i, "")
        lines.append(f'[{i}]{star}<{el.role} "{el.name}"{ctx}{val}{pos}{opts}{ordinal}{off}>')
    head = f"{len(lines)} interactive elements (* = new since your last look):"
    text = head + "\n" + "\n".join(lines)
    if truncated > 0:
        text += f"\n... {truncated} more not shown; scroll or scope to reach them."
    return text
