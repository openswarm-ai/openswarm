import os
from debugger_backend.DEFAULTS import ROOT_DIR

def get_abspath(path: str):
    return os.path.join(ROOT_DIR, path)

def get_root_rel_path(path: str):
    assert path.startswith(ROOT_DIR)
    path = path[len(ROOT_DIR):]
    while path.startswith(os.sep):
        path = path[1:]
    return path
