import os
from typing import Optional
from typeguard import typechecked


# TODO: type spec this entirely
@typechecked
def find_9router_dir(
    root_dir: str,
) -> Optional[str]:
    """Locate the bundled 9Router directory (dev or packaged)."""
    p_is_packaged: bool = os.environ.get("OPENSWARM_PACKAGED") == "1"

    if p_is_packaged:
        p_resources: str = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(root_dir))))
        p_candidate: str = os.path.join(p_resources, "9router")
        if os.path.isdir(p_candidate):
            return p_candidate
    else:
        p_backend_dir: str = os.path.dirname(os.path.dirname(os.path.dirname(root_dir)))
        p_project_root: str = os.path.dirname(p_backend_dir)
        p_candidate = os.path.join(p_project_root, "9router")
        if os.path.isdir(p_candidate):
            return p_candidate

    return None
