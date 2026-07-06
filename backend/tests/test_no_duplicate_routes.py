"""Route-collision guard: no two handlers may register the same (method, path).

The bug class: two files registered POST /api/agents/sessions/{id}/compact (and
/clear). Starlette silently serves the first-registered one, so the second handler
was dead code AND the live one had the wrong behavior (marker-only /compact never
rebuilt). Nothing surfaced it, because a duplicate route is not an error to Starlette.

The seal: enumerate the built app's routes and fail on any duplicate (method, path).
A shadowed route can never ship again; the machine catches it, not a human months later.
"""

from collections import Counter

from backend.main import app


def test_no_duplicate_method_path_routes() -> None:
    pairs = []
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if path is None or not methods:
            continue
        for method in methods:
            pairs.append((method, path))
    dupes = [pair for pair, n in Counter(pairs).items() if n > 1]
    assert not dupes, (
        "Duplicate route registrations (one silently shadows the other; "
        f"consolidate to a single handler): {sorted(dupes)}"
    )
