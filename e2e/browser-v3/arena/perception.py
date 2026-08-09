"""Turn a BrowserGym observation into the element list each arm is allowed to see.

Both arms read the SAME underlying accessibility tree, which is the point: the comparison is between
what each stack does with the tree (browser-use dumps it flat, OpenSwarm dedupes/ranks/caps/marks it),
not between two different ways of getting one. Anything that advantaged one arm's raw perception
would make the score a measurement of plumbing.
"""
from __future__ import annotations

from typing import Any

from ranking import INTERACTIVE_ROLES, RankItem

# Roles carrying page copy; used to build the ctx string that disambiguates same-named twins.
TEXT_ROLES = {"StaticText", "LabelText", "heading", "paragraph", "InlineTextBox"}


def node_role(node: dict[str, Any]) -> str:
    return str((node.get("role") or {}).get("value") or "")


def node_name(node: dict[str, Any]) -> str:
    return str((node.get("name") or {}).get("value") or "")


def node_value(node: dict[str, Any]) -> str:
    v = node.get("value") or {}
    return str(v.get("value") or "") if isinstance(v, dict) else ""


def visible(bid: str, extra: dict[str, Any], threshold: float = 0.5) -> bool:
    """Our dropCoveredElements analogue: an element under an overlay is not an element you can click."""
    props = extra.get(bid) if extra else None
    if not props:
        return True
    try:
        return float(props.get("visibility", 1.0)) >= threshold
    except (TypeError, ValueError):
        return True


def build_context(nodes: list[dict[str, Any]], by_id: dict[str, dict[str, Any]],
                  node: dict[str, Any], depth: int = 3) -> str:
    """Nearest ancestor's text, so five identical 'Message' buttons say which card they belong to."""
    cur = node
    for _ in range(depth):
        parent_id = cur.get("parentId")
        if not parent_id or parent_id not in by_id:
            return ""
        parent = by_id[parent_id]
        texts: list[str] = []
        for cid in parent.get("childIds") or []:
            child = by_id.get(cid)
            if not child or child is node:
                continue
            if node_role(child) in TEXT_ROLES:
                t = node_name(child).strip()
                if t:
                    texts.append(t)
        if texts:
            return " ".join(texts)[:60]
        cur = parent
    return ""


def interactives(obs: dict[str, Any], include_hidden: bool = False,
                 include_clickable: bool = False) -> list[RankItem]:
    """Every actionable node in document order, before any ranking or capping is applied.

    include_clickable is the technique ingested from browser-use: elements the page wires for
    clicks but gives no interactive AX role -- canvases, SVGs, styled divs. Measured on MiniWoB,
    their flat dump solved spatial tasks (circle-center, bisect-angle) purely because the canvas
    appeared in it while our role-filtered menu hid the only thing worth clicking.
    """
    ax = obs.get("axtree_object") or {}
    nodes: list[dict[str, Any]] = ax.get("nodes") or []
    extra = obs.get("extra_element_properties") or {}
    by_id = {n["nodeId"]: n for n in nodes if "nodeId" in n}
    out: list[RankItem] = []
    for n in nodes:
        if n.get("ignored"):
            continue
        role = node_role(n)
        bid = n.get("browsergym_id")
        if not bid:
            continue
        is_role = role in INTERACTIVE_ROLES
        is_clickable = (include_clickable and not is_role and role not in TEXT_ROLES
                        and bool((extra.get(str(bid)) or {}).get("clickable")))
        if not (is_role or is_clickable):
            continue
        if not include_hidden and not visible(str(bid), extra):
            continue
        name = node_name(n).strip()
        bbox = (extra.get(str(bid)) or {}).get("bbox")
        center = (bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2) if bbox else None
        out.append(RankItem(
            role=role if is_role else (role or "clickable"),
            name=name,
            bid=str(bid),
            value=node_value(n)[:80],
            context=build_context(nodes, by_id, n),
            center=center,
            options=child_options(by_id, n) if role in ("combobox", "listbox", "menu") else None,
        ))
    return out


OPTION_ROLES = {"option", "menuitem", "MenuListOption", "ListBoxOption"}


def child_options(by_id: dict[str, dict[str, Any]], node: dict[str, Any], depth: int = 3) -> list[str] | None:
    """Option labels under a select-like node, ignored-or-not: a closed <select> hides its options
    from the visible tree, and without their names the model can only click the box in a loop."""
    found: list[str] = []

    def walk(n: dict[str, Any], d: int) -> None:
        if d > depth:
            return
        for cid in n.get("childIds") or []:
            child = by_id.get(cid)
            if not child:
                continue
            if node_role(child) in OPTION_ROLES:
                label = node_name(child).strip()
                if label:
                    found.append(label)
            walk(child, d + 1)

    walk(node, 0)
    return found or None


def page_text(obs: dict[str, Any], limit: int = 1200) -> str:
    """The page's visible text, compact: what our product's BrowserGetText gives the agent.

    Without it the menu-only view cannot answer tasks whose payload lives in prose -- the algebra
    equation, which email row is Cecile's -- and the model scrolls in the dark while a flat-dump
    agent just reads the answer.
    """
    ax = obs.get("axtree_object") or {}
    nodes: list[dict[str, Any]] = ax.get("nodes") or []
    parts: list[str] = []
    seen: set[str] = set()
    for n in nodes:
        if n.get("ignored"):
            continue
        if node_role(n) in ("StaticText", "LabelText", "heading"):
            t = node_name(n).strip()
            if t and t not in seen:
                seen.add(t)
                parts.append(t)
    text = " | ".join(parts)
    return text[:limit]


def axtree_stats(obs: dict[str, Any]) -> tuple[int, int]:
    """(node count, flattened char count) so token pressure is a recorded metric, not a guess."""
    ax = obs.get("axtree_object") or {}
    nodes = ax.get("nodes") or []
    try:
        from browsergym.utils.obs import flatten_axtree_to_str

        chars = len(flatten_axtree_to_str(ax))
    except Exception:
        chars = 0
    return len(nodes), chars


def dom_chars(obs: dict[str, Any]) -> int:
    try:
        from browsergym.utils.obs import flatten_dom_to_str

        return len(flatten_dom_to_str(obs.get("dom_object") or {}))
    except Exception:
        return 0
