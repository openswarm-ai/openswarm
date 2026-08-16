"""Containment guard for the one tool that hands a local file to a web page.

The browser sub-agent reads its instructions off the page it is driving, so a hostile page can ask
it for anything. Uploading is the first browser tool that can move bytes OFF the machine, which
makes it the only one where a prompt injection converts into exfiltration. So the path is resolved
against an allow-list here, on the backend, before the command ever reaches the renderer: the
agent can offer any string it likes and still cannot name `~/.ssh/id_rsa`.
"""

import os
from typing import List
from typeguard import typechecked

from backend.apps.settings.settings import legacy_upload_dir, upload_dir
from backend.config.paths import OUTPUTS_WORKSPACE_DIR, SKILLS_WORKSPACE_DIR

# Big enough for a portfolio PDF or a short video, small enough that a runaway loop can't post a disk image.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


class UploadPathRefused(Exception):
    """The requested file is outside every allowed root, missing, or too large."""


@typechecked
def allowed_upload_roots() -> List[str]:
    """Roots a file may be uploaded from: what the user attached, and what agents produce."""
    # ~/.openswarm/workspaces is where a chat agent's own scratch cwd lives (AgentLaunch), so a file
    # the agent just wrote and now wants to upload is covered without opening up the whole home dir.
    # The legacy temp-dir root stays allowed: a file attached BEFORE the ENG-312 move keeps working.
    roots = [
        upload_dir(), legacy_upload_dir(), OUTPUTS_WORKSPACE_DIR, SKILLS_WORKSPACE_DIR,
        os.path.join(os.path.expanduser("~"), ".openswarm", "workspaces"),
    ]
    out: List[str] = []
    for r in roots:
        try:
            out.append(os.path.realpath(r))
        except OSError:
            continue
    return out


@typechecked
def resolve_upload_path(path: str) -> str:
    """Absolute real path of an uploadable file, or raise UploadPathRefused.

    realpath both sides, then compare whole components: without the trailing separator a root named
    `uploads` would also own `uploads-evil`, and plain string math walks straight through a symlink
    planted inside an allowed root and pointing at the user's home.
    """
    raw = (path or "").strip()
    if not raw:
        raise UploadPathRefused("No file path given.")
    target = os.path.realpath(os.path.expanduser(raw))
    roots = allowed_upload_roots()
    staging = upload_dir()
    if not any(target == r or target.startswith(r + os.sep) for r in roots):
        # Name the fix, not just the rule. The PARENT agent can read anywhere and is not driven by
        # page content, so staging the file is safe there and is the one move that unblocks this.
        raise UploadPathRefused(
            f"Refused: {raw} is outside the folders a page-driven agent may upload from. "
            f"Ask the agent that sent you here to copy the file to {staging} first "
            f"(e.g. `cp \"{raw}\" {staging}/`), then upload it from there."
        )
    if not os.path.isfile(target):
        raise UploadPathRefused(f"Refused: {raw} is not a file that exists.")
    size = os.path.getsize(target)
    if size > MAX_UPLOAD_BYTES:
        raise UploadPathRefused(
            f"Refused: {raw} is {size // (1024 * 1024)}MB, over the {MAX_UPLOAD_BYTES // (1024 * 1024)}MB upload cap."
        )
    return target
