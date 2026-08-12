"""Workspaces on disk that no app record points at, and what reclaiming them would free.

Deleting an app used to leave its whole source tree behind (ENG-268), so installs carry orphans from
every app ever discarded: 9 of them, ~0.85GB, measured on one machine. That leak is fixed at the
delete path, but the existing pile is still there and nothing surfaces it.

Deliberately a REPORT plus an explicit delete, never an unattended sweep. `recover_orphaned_apps`
re-registers orphans that still carry a real name, so a background cleaner racing it would be two
jobs disagreeing about the same folder, and one of them silently destroying work the other is trying
to restore. Listing is free and safe; deleting is the user's call, one id at a time.
"""

import os
import shutil
from typing import List, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.config.json_store import read_json_or_none
from backend.config.paths import OUTPUTS_DIR, OUTPUTS_WORKSPACE_DIR


class OrphanWorkspace(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    workspace_id: str
    name: str
    bytes_on_disk: int
    # node_modules is a symlink farm into the shared template cache, so a naive du triple-counts it
    # across apps and reports a number that would not actually come back.
    reclaimable_bytes: int


@typechecked
def p_tree_bytes(path: str, follow_symlinks: bool = False) -> int:
    total = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=follow_symlinks):
        if not follow_symlinks and os.path.basename(dirpath) == "node_modules":
            dirnames[:] = []
            continue
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                if not follow_symlinks and os.path.islink(fp):
                    continue
                total += os.path.getsize(fp)
            except OSError:
                continue
    return total


@typechecked
def p_referenced_workspace_ids() -> set:
    """Every workspace some app record still points at."""
    out = set()
    if not os.path.isdir(OUTPUTS_DIR):
        return out
    for fn in os.listdir(OUTPUTS_DIR):
        if not fn.endswith(".json"):
            continue
        rec = read_json_or_none(os.path.join(OUTPUTS_DIR, fn))
        wsid = (rec or {}).get("workspace_id")
        if isinstance(wsid, str) and wsid:
            out.add(wsid)
    return out


@typechecked
def p_workspace_name(workspace_dir: str) -> str:
    meta = read_json_or_none(os.path.join(workspace_dir, "meta.json")) or {}
    name = meta.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else "(unnamed)"


@typechecked
def list_orphan_workspaces() -> List[OrphanWorkspace]:
    """Read-only. Never deletes, so it is safe to call from anywhere, including a status surface."""
    if not os.path.isdir(OUTPUTS_WORKSPACE_DIR):
        return []
    referenced = p_referenced_workspace_ids()
    out: List[OrphanWorkspace] = []
    for wsid in sorted(os.listdir(OUTPUTS_WORKSPACE_DIR)):
        path = os.path.join(OUTPUTS_WORKSPACE_DIR, wsid)
        if not os.path.isdir(path) or wsid in referenced:
            continue
        out.append(OrphanWorkspace(
            workspace_id=wsid,
            name=p_workspace_name(path),
            bytes_on_disk=p_tree_bytes(path, follow_symlinks=False),
            reclaimable_bytes=p_tree_bytes(path, follow_symlinks=False),
        ))
    return out


@typechecked
def delete_orphan_workspace(workspace_id: str) -> Optional[int]:
    """Remove ONE orphan by id, refusing anything still referenced or outside the root.

    Returns the bytes freed, or None when the id is not a deletable orphan. Same realpath +
    component-boundary guard the delete path uses: an id is stored data and rmtree is not a call to
    take on trust.
    """
    if workspace_id in p_referenced_workspace_ids():
        return None
    root = os.path.realpath(OUTPUTS_WORKSPACE_DIR)
    target = os.path.realpath(os.path.join(root, workspace_id))
    if target == root or not target.startswith(root + os.sep) or not os.path.isdir(target):
        return None
    freed = p_tree_bytes(target, follow_symlinks=False)
    shutil.rmtree(target, ignore_errors=True)
    return freed
