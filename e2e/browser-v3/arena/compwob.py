"""Register CompWoB (compositional MiniWoB, Furuta et al.) as BrowserGym tasks.

CompWoB exists to test exactly one thing: whether high MiniWoB scores are memorization or ability
-- specialist systems fell 95%->61% on it. We reuse BrowserGym's own MiniWoB task class untouched,
pointed at the composed pages, so there is ZERO new scoring code here to be wrong: the reward is
the same page-owned WOB_REWARD_GLOBAL machinery MiniWoB itself uses, already canary-validated.

Task ids: `compwob.<page-name>` -- the runner's existing dotted-id path handles them unchanged.
Serving: the composed pages live at MINIWOB_URL/../compwob/<name>.html next to the shared assets.
"""
from __future__ import annotations

import os
from pathlib import Path

from browsergym.core.registration import register_task
from browsergym.miniwob.base import AbstractMiniwobTask

COMPWOB_DIR = Path(os.environ.get(
    "COMPWOB_HTML_DIR",
    Path(os.environ.get("MINIWOB_SCRATCH",
                        "/private/tmp/claude-501/-Users-eric/33681c21-c82a-490e-a036-c4c0ec1414bd/scratchpad"))
    / "miniwob-plusplus" / "miniwob" / "html" / "compwob"))


def compwob_page_names() -> list[str]:
    """Discovered from the served directory, so the registry can never drift from reality."""
    if not COMPWOB_DIR.is_dir():
        return []
    return sorted(p.stem for p in COMPWOB_DIR.glob("*.html"))


ALL_COMPWOB_TASKS: list[type] = []

for _name in compwob_page_names():
    # '../compwob/<name>' rides the miniwob base_url; the browser normalizes the parent hop.
    _cls = type(
        f"Compwob_{_name.replace('-', '_').replace('.', '_')}",
        (AbstractMiniwobTask,),
        {"subdomain": f"../compwob/{_name}", "desc": f"CompWoB composed task {_name}"},
    )
    # Stable public id: compwob.<name> (the subdomain's ../ prefix stays an URL detail).
    _cls.get_task_id = classmethod(lambda cls, n=_name: f"compwob.{n}")
    ALL_COMPWOB_TASKS.append(_cls)
    register_task(_cls.get_task_id(), _cls, nondeterministic=_cls.nondeterministic)
