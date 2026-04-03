"""Pure prompt-building helpers.

All functions are stateless — they accept data as parameters and return
strings.  No imports from ``apps/`` or any external stores.
"""

import os
from typing import List

from backend.core.shared_structs.agent.Message.agent_inputs import ContextPath, SkillMeta
from typeguard import typechecked

MAX_FILE_READ_BYTES = 512_000
DIR_TREE_MAX_DEPTH = 4

@typechecked
def p_build_dir_tree(
    root: str,
    max_depth: int = DIR_TREE_MAX_DEPTH,
    prefix: str = "",
) -> List[str]:
    lines: List[str] = []
    try:
        entries: List[str] = sorted(os.listdir(root))
    except PermissionError:
        return [f"{prefix}[permission denied]"]
    dirs: List[str] = [
        e for e in entries
        if not e.startswith(".") and os.path.isdir(os.path.join(root, e))
    ]
    files: List[str] = [
        e for e in entries
        if not e.startswith(".") and os.path.isfile(os.path.join(root, e))
    ]
    for f in files:
        lines.append(f"{prefix}{f}")
    for d in dirs:
        lines.append(f"{prefix}{d}/")
        if max_depth > 1:
            lines.extend(p_build_dir_tree(os.path.join(root, d), max_depth - 1, prefix + "  "))
    return lines


@typechecked
def resolve_context_paths(context_paths: List[ContextPath]) -> str:
    """Read files / build directory trees for each context path."""
    if not context_paths:
        return ""
    sections: List[str] = []
    for cp in context_paths:
        path: str = cp.path
        cp_type: str = cp.type
        if not path or not os.path.exists(path):
            sections.append(f"[Context: {path} — not found]")
            continue
        if cp_type == "file" and os.path.isfile(path):
            try:
                with open(path, "r", errors="replace") as f:
                    content: str = f.read(MAX_FILE_READ_BYTES)
                sections.append(
                    f'<context_file path="{path}">\n{content}\n</context_file>'
                )
            except Exception as e:
                sections.append(f"[Context: {path} — error reading: {e}]")
        elif cp_type == "directory" and os.path.isdir(path):
            tree = p_build_dir_tree(path, max_depth=DIR_TREE_MAX_DEPTH)
            sections.append(
                f'<context_directory path="{path}">\n{chr(10).join(tree)}\n</context_directory>'
            )
        else:
            sections.append(f"[Context: {path} — type mismatch]")
    return "\n\n".join(sections)


@typechecked
def resolve_forced_tools(forced_tools: List[str]) -> str:
    """Build a <forced_tools> prompt block from a list of tool names."""
    if not forced_tools:
        return ""
    lines: List[str] = [f"- {name}" for name in forced_tools]
    return (
        "<forced_tools>\n"
        "The user explicitly requested these tools be used. "
        "Prioritize using them to address the user's request.\n"
        + "\n".join(lines)
        + "\n</forced_tools>"
    )


@typechecked
def resolve_attached_skills(attached_skills: List[SkillMeta]) -> str:
    """Format attached skills into prompt sections."""
    if not attached_skills:
        return ""
    sections: List[str] = []
    for skill in attached_skills:
        name: str = skill.name
        content: str = skill.content
        if content:
            sections.append(f"[Using skill: {name}]\n\n{content}")
    return "\n\n".join(sections)