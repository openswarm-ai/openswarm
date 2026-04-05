"""Default template files seeded into new App Builder workspaces."""

import os
from typing import Dict
from typeguard import typechecked

P_SELF_DIR = os.path.dirname(__file__)
P_CONTENT_DIR = os.path.join(P_SELF_DIR, "content")

@typechecked
def p_read(filename: str) -> str:
    with open(os.path.join(P_CONTENT_DIR, filename)) as f:
        return f.read()

APP_BUILDER_SKILL: str = p_read("app_builder_skill.md")

APP_BUILDER_TEMPLATE_FILES: Dict[str, str] = {
    "index.html": p_read("template_index.html"),
    "meta.json": p_read("template_meta.json"),
}