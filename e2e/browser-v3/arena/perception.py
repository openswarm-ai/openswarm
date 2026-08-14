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
    def texts_under(n: dict[str, Any], levels: int) -> list[str]:
        found: list[str] = []
        for cid in n.get("childIds") or []:
            child = by_id.get(cid)
            if not child or child is node:
                continue
            if node_role(child) in TEXT_ROLES:
                t = node_name(child).strip()
                if t:
                    found.append(t)
            elif levels > 0:
                # One level down inside sibling wrappers: an email row's sender name lives in
                # <span class=sender><text> -- a direct-children-only walk never saw it.
                found.extend(texts_under(child, levels - 1))
        return found

    cur = node
    for _ in range(depth):
        parent_id = cur.get("parentId")
        if not parent_id or parent_id not in by_id:
            return ""
        parent = by_id[parent_id]
        texts = texts_under(parent, 3)
        if texts:
            return " ".join(texts)[:60]
        cur = parent
    return ""


def dom_group_hints(obs: dict[str, Any], max_group: int = 8) -> dict[str, str]:
    """bid -> '§ <label>' from the nearest SMALL labeled DOM ancestor (id or first class token).

    The AX tree prunes unlabeled wrappers, flattening section structure ('div.widget > input'
    arrives as a bare textbox among 29 siblings). The DOM snapshot still has it. An ancestor
    only counts if few enough bids live under it (<= max_group) -- page-level wrappers like
    <div id=area> label everything and therefore label nothing."""
    out: dict[str, str] = {}
    dom = obs.get("dom_object") or {}
    strings: list[str] = dom.get("strings") or []
    for doc in dom.get("documents") or []:
        nd = doc.get("nodes") or {}
        parent: list[int] = nd.get("parentIndex") or []
        attr_rows: list[list[int]] = nd.get("attributes") or []
        n = len(parent)
        pairs: list[dict[str, str]] = []
        for a in attr_rows:
            pairs.append({strings[a[k]]: strings[a[k + 1]] for k in range(0, len(a) - 1, 2)})
        while len(pairs) < n:
            pairs.append({})
        cnt = [0] * n
        withbid = [i for i in range(n) if pairs[i].get("bid")]
        for i in withbid:
            j = parent[i]
            while 0 <= j < n:
                cnt[j] += 1
                j = parent[j]
        for i in withbid:
            j = parent[i]
            while 0 <= j < n:
                p = pairs[j]
                label = (p.get("id") or (p.get("class") or "").split(" ")[0]).strip()
                if label and not label.startswith("browsergym") and cnt[j] <= max_group:
                    out[pairs[i]["bid"]] = f"§ {label[:24]}"
                    break
                if cnt[j] > max_group:
                    break  # every higher ancestor is even bigger
                j = parent[j]
    return out


def build_local_context(by_id: dict[str, dict[str, Any]], node: dict[str, Any],
                        inter_ids: set, name_of, depth: int = 4) -> str:
    """v29: context from the node's LOCAL GROUP -- the names of its fellow members in the
    smallest ancestor holding 2..8 interactives. build_context's nearest-ancestor-with-text
    walk degrades to identical page-level soup on multi-section pages, so same-role nameless
    twins (two anonymous textboxes in different sections) rendered indistinguishably and the
    model's pick was a measured coin flip. Sibling names differ per section by construction."""
    memo: dict[str, int] = {}

    def icount(nid: str) -> int:
        if nid in memo:
            return memo[nid]
        memo[nid] = 0  # cycle guard
        n = by_id.get(nid) or {}
        c = (1 if nid in inter_ids else 0) + sum(icount(cid) for cid in n.get("childIds") or [])
        memo[nid] = c
        return c

    def members(nid: str, out: list, self_id: str) -> None:
        if len(out) > 8:
            return
        if nid in inter_ids and nid != self_id:
            out.append(nid)
        for cid in (by_id.get(nid) or {}).get("childIds") or []:
            members(cid, out, self_id)

    self_id = node.get("nodeId")
    cur = node
    for _ in range(depth):
        pid = cur.get("parentId")
        if not pid or pid not in by_id:
            break
        parent = by_id[pid]
        k = icount(pid)
        if 2 <= k <= 8:
            got: list = []
            members(pid, got, self_id)
            names = [name_of(by_id[m])[:14] for m in got]
            names = [x for x in names if x]
            if names:
                return "w/ " + " ".join(names)[:56]
        cur = parent
    return ""


def interactives(obs: dict[str, Any], include_hidden: bool = False,
                 include_clickable: bool = False, attr_hints: bool = False,
                 include_offscreen: bool = False, local_ctx: bool = False,
                 suppress_wrappers: bool = False) -> list[RankItem]:
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
    hints = dom_attr_hints(obs) if attr_hints else {}
    picked: list[tuple[dict[str, Any], str, str, dict[str, Any], bool]] = []
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
        props = extra.get(str(bid)) or {}
        onscreen = visible(str(bid), extra)
        # A row with a bbox is RENDERED; visibility<threshold just means below the fold. display:none
        # yields no bbox and stays excluded.
        if not onscreen and not include_hidden:
            if not (include_offscreen and props.get("bbox")):
                continue
        picked.append((n, role if is_role else (role or "clickable"), str(bid), props, onscreen))

    def display_name(n: dict[str, Any]) -> str:
        # Nameless rows resolve by their OWN text first ('dignissim' from the child text node), and
        # only then by DOM identity ('(trash)'). The class hint alone made every link in a tab panel
        # read '(alink)' -- indistinguishable, so the model guessed and the guess was terminal.
        nm = node_name(n).strip() or subtree_text(by_id, n)
        b = str(n.get("browsergym_id") or "")
        if not nm and b in hints:
            nm = f"({hints[b]})"
        return nm

    inter_ids = {n.get("nodeId") for n, *_ in picked}
    if suppress_wrappers and picked:
        # A weak-named clickable whose subtree holds exactly ONE other picked element is that
        # element's wrapper: a trap row ('(widget)') that looks like the thing and eats the click
        # the page only counts on the child. Keep the properly-roled child, drop the shell.
        memo: dict[str, int] = {}

        def pdesc(nid: str) -> int:
            if nid in memo:
                return memo[nid]
            memo[nid] = 0
            node = by_id.get(nid) or {}
            c = sum((1 if cid in inter_ids else 0) + pdesc(cid) for cid in node.get("childIds") or [])
            memo[nid] = c
            return c

        kept = []
        for tup in picked:
            n = tup[0]
            nm = node_name(n).strip()
            weak = not nm or nm.startswith("(")
            if weak and n.get("nodeId") and pdesc(n["nodeId"]) == 1:
                continue
            kept.append(tup)
        if kept:
            picked = kept
            inter_ids = {n.get("nodeId") for n, *_ in picked}
    grp = dom_group_hints(obs) if local_ctx else {}
    out: list[RankItem] = []
    for n, role, bid, props, onscreen in picked:
        name = display_name(n)
        bbox = props.get("bbox")
        center = (bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2) if bbox else None
        ctx = ""
        if local_ctx:
            ctx = grp.get(bid) or build_local_context(by_id, n, inter_ids, display_name)
        if not ctx:
            ctx = build_context(nodes, by_id, n)
        out.append(RankItem(
            role=role,
            name=name,
            bid=bid,
            value=node_value(n)[:80],
            context=ctx,
            center=center,
            options=child_options(by_id, n) if role in ("combobox", "listbox", "menu") else None,
            offscreen=not onscreen,
        ))
    return out


def subtree_text(by_id: dict[str, dict[str, Any]], node: dict[str, Any], levels: int = 2) -> str:
    """Text living INSIDE the node -- a styled link's label is a child StaticText, not an AX name."""
    found: list[str] = []

    def walk(n: dict[str, Any], d: int) -> None:
        for cid in n.get("childIds") or []:
            child = by_id.get(cid)
            if not child:
                continue
            if node_role(child) in TEXT_ROLES:
                t = node_name(child).strip()
                if t:
                    found.append(t)
            elif d > 0:
                walk(child, d - 1)

    walk(node, levels)
    return " ".join(found)[:60]


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


# DOM attributes worth surfacing when the AX name is empty, most-identifying first.
HINT_ATTRS = ("aria-label", "title", "alt", "placeholder", "name", "id", "class")


def dom_attr_hints(obs: dict[str, Any]) -> dict[str, str]:
    """bid -> best identifying DOM attribute, for nodes the AX tree names as nothing.

    Ingested from browser-use: a trash icon is <span class="trash"> in the DOM and '' in the AX
    tree, and every email task turns on knowing which nameless icon is which.
    """
    out: dict[str, str] = {}
    dom = obs.get("dom_object") or {}
    strings: list[str] = dom.get("strings") or []
    for doc in dom.get("documents") or []:
        for attr_idxs in (doc.get("nodes") or {}).get("attributes") or []:
            pairs = {}
            for k in range(0, len(attr_idxs) - 1, 2):
                pairs[strings[attr_idxs[k]]] = strings[attr_idxs[k + 1]]
            bid = pairs.get("bid")
            if not bid:
                continue
            for attr in HINT_ATTRS:
                v = (pairs.get(attr) or "").strip()
                if v and not v.startswith("browsergym"):
                    out[bid] = v[:40]
                    break
    return out


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
