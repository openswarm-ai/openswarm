"""`POST /api/outputs/create` advertises `workspace_id` in its request model and used to drop it on the
floor: an API caller's app had no workspace, its card said the files were missing, and the Windows
CI round trip exported an empty app before it ever reached the importer (2026-09-04)."""

import inspect

from backend.apps.outputs import outputs


def test_create_carries_the_workspace_id_into_the_record():
    src = inspect.getsource(outputs.create_output)
    assert "workspace_id=body.workspace_id" in src
