"""Turn a flat list of pytest node IDs into a selectable tree.

Node ID shapes handled:
    tests/unit/test_tokens.py::test_roundtrip
    tests/unit/test_route_classifier.py::test_models[gemini-3-flash]   (parametrized)

Directories and files become inner nodes; a parametrized function becomes an
inner node whose leaves are its individual cases; a plain function is a leaf.
Only leaves carry a runnable node_id.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TNode:
    label: str
    kind: str  # 'dir' | 'file' | 'func' | 'case'
    node_id: str | None = None  # set only on leaves (func without params, or case)
    children: list["TNode"] = field(default_factory=list)

    @property
    def is_leaf(self) -> bool:
        return not self.children

    def _find_or_add(self, label: str, kind: str) -> "TNode":
        for child in self.children:
            if child.label == label and child.kind == kind:
                return child
        child = TNode(label=label, kind=kind)
        self.children.append(child)
        return child

    def leaf_ids(self) -> list[str]:
        if self.is_leaf:
            return [self.node_id] if self.node_id else []
        out: list[str] = []
        for child in self.children:
            out.extend(child.leaf_ids())
        return out


def build_tree(node_ids: list[str], root_label: str = "tests") -> TNode:
    root = TNode(label=root_label, kind="dir")
    for nid in node_ids:
        file_part, _, test_part = nid.partition("::")
        segments = [s for s in file_part.split("/") if s]
        # Drop a leading "tests" segment so it nests under the single root.
        if segments and segments[0] == root_label:
            segments = segments[1:]

        cursor = root
        for seg in segments[:-1]:
            cursor = cursor._find_or_add(seg, "dir")
        if segments:
            cursor = cursor._find_or_add(segments[-1], "file")

        if "[" in test_part:
            func_name = test_part.split("[", 1)[0]
            func_node = cursor._find_or_add(func_name, "func")
            func_node.children.append(
                TNode(label=test_part, kind="case", node_id=nid)
            )
        else:
            cursor.children.append(
                TNode(label=test_part, kind="func", node_id=nid)
            )
    _sort(root)
    return root


def _sort(node: TNode) -> None:
    # Dirs first, then files, then funcs/cases; alphabetical within a kind.
    order = {"dir": 0, "file": 1, "func": 2, "case": 3}
    node.children.sort(key=lambda c: (order.get(c.kind, 9), c.label))
    for child in node.children:
        _sort(child)
