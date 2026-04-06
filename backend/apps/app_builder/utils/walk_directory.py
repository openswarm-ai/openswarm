import os
from typing import Dict
from typeguard import typechecked

@typechecked
def walk_directory(folder: str) -> Dict[str, str]:
    files: Dict[str, str] = {}
    if not os.path.isdir(folder):
        return files
    for root, _dirs, filenames in os.walk(folder):
        for fname in filenames:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, folder)
            try:
                with open(full_path) as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
    return files
