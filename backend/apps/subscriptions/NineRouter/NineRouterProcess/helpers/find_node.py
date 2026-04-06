import os
import shutil
from typing import Optional
from typeguard import typechecked


@typechecked
def find_node() -> Optional[str]:
    node: Optional[str] = shutil.which("node")
    if node:
        return node
    electron_path: Optional[str] = os.environ.get("OPENSWARM_ELECTRON_PATH")
    if electron_path and os.path.exists(electron_path):
        return electron_path
    return None