"""A serve-static app must report a URL (found 2026-08-14 by a long-run user simulation, and it is
the "app loads forever until I open a second instance" report).

ENG-209 lets a fresh built bundle be served with NO process. `running` is defined as "has a live
process", so it is False for those by design, and the status payload re-gated `frontend_url` on
`running`: the API said there was no URL, the preview pane had nothing to navigate to, and the app
spun forever. A SECOND instance skips serve mode entirely (`instance == 1` gate), which is exactly
why opening another window "fixed" it. Measured live: one app in the corpus was permanently
unopenable this way; after the fix it serves real HTML.
"""

import inspect

from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs.runtime import AppRuntime


def test_status_asks_the_property_instead_of_re_gating_on_running():
    src = inspect.getsource(outputs_mod.runtime_status_payload)
    line = next(ln for ln in src.splitlines() if '"frontend_url"' in ln and "None," not in ln)
    assert "rt.running" not in line, (
        "re-gating frontend_url on `running` blanks it for serve-static apps, which have no "
        "process by design; the property already handles ready/suspended/dead-vite"
    )
    assert "rt.frontend_url" in line


def test_the_property_itself_answers_for_serve_static():
    src = inspect.getsource(AppRuntime.frontend_url.fget)
    i_serve = src.find("self.serve_static")
    i_running = src.find("self.running")
    assert i_serve != -1, "the property must special-case serve mode"
    assert i_running == -1 or i_serve < i_running, (
        "serve mode must be answered BEFORE any running check, or the processless path returns None"
    )


def test_serve_mode_is_still_gated_to_the_primary_instance():
    # The second-instance escape hatch is what made the bug survivable; keep it working.
    src = inspect.getsource(AppRuntime.p_start_new_mode)
    assert "self.instance == 1" in src
