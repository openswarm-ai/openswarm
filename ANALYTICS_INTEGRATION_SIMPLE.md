# Analytics Integration — Simple First Pass (one log write)

**Goal of this pass:** wire the `swarm-analytics` SDK into the OpenSwarm desktop
backend with the *minimum* needed to prove the pipe works end to end — set up a
client once at startup and send a **single log write** (`backend_started`). No
product events, no spool yet. Those come later.

Read `ANALYTICS_OVERVIEW.md` first for how the SDK works. This file is the
concrete edit list for the **desktop app repo** (`openswarm/`).

---

## Where things live (desktop app)

- Backend entry: `backend/main.py` — composes SubApps; **already creates
  `settings.installation_id` at boot** (before the port binds). This is the
  `install_id` we reuse; it is guaranteed to exist by the time any SubApp
  lifespan runs.
- Service SubApp: `backend/apps/service/service.py` — its `service_lifespan()` is
  where existing startup telemetry fires and is the home for our setup + first
  log write.
- Settings model + store: `backend/apps/settings/models.py` (the `AppSettings`
  pydantic model) and `backend/apps/settings/store.py` (`load_settings()` /
  `save_settings()`).
- Settings write-guard: `backend/apps/settings/settings.py`
  (`P_SERVER_OWNED_FIELDS`).

---

## Decisions already made

- **Base URL:** read from env var `OPENSWARM_ANALYTICS_URL`, defaulting to
  `http://127.0.0.1:6792` for local end-to-end testing — that's the port the
  analytics service listens on (its `.env` sets `BACKEND_PORT=6792`; `8324` is
  only the hardcoded fallback in its `main.py` when `BACKEND_PORT` is unset).
  - No port collision with the desktop backend: the analytics service runs on
    `6792` and the desktop backend defaults to `8324` (`OPENSWARM_PORT`). They
    can run side by side locally.
- **Token bootstrap timing:** call `register()` at startup inside
  `service_lifespan()` (one blocking network round-trip at boot). The setup
  helper swallows failures (returns `None`), so an offline first launch just
  skips analytics and retries on the next boot.

---

## The 5 edits

### 1. Add the dependency — `backend/requirements.txt`

Add a pinned line alongside the other pins:

```
swarm-analytics==0.1.0
```

(Use whatever version is published. Pinned because desktop builds are
reproducible.)

---

### 2. Add a token field — `backend/apps/settings/models.py`

In the `AppSettings` model, next to the other `*_token` fields (e.g. near
`openswarm_bearer_token` / `installation_id`), add:

```python
    analytics_token: Optional[str] = None
```

This persists the token minted by `register()` so we only bootstrap once.

---

### 3. Protect the token from renderer overwrites — `backend/apps/settings/settings.py`

Add `"analytics_token"` to the `P_SERVER_OWNED_FIELDS` tuple, so a full-object
`PUT /api/settings` from a stale frontend snapshot can't forge or wipe it:

```python
P_SERVER_OWNED_FIELDS = (
    "connection_mode",
    "openswarm_bearer_token",
    # ... existing entries ...
    "installation_id",
    "analytics_token",   # <-- add
    # ...
)
```

---

### 4. New singleton module — `backend/apps/service/analytics.py`

Create this file. It owns the one client per process, bootstraps the token
lazily, maps the existing opt-out toggle onto `mode`, and exposes a getter +
shutdown.

```python
"""swarm-analytics client singleton for the desktop backend.

One client per process. Bootstraps an install token on first use (persisted to
settings) and reuses it forever. All failures are swallowed — analytics must
never break the app.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from swarm_analytics import AnalyticsClient

logger = logging.getLogger(__name__)

P_CLIENT: Optional[AnalyticsClient] = None


def p_base_url() -> str:
    # Local default is the analytics service's dev port (its .env BACKEND_PORT).
    # In prod, set OPENSWARM_ANALYTICS_URL to the deployed analytics URL.
    return os.environ.get("OPENSWARM_ANALYTICS_URL", "http://127.0.0.1:6792").rstrip("/")


def p_mode() -> str:
    """Map the existing diagnostics/opt-out toggle onto the SDK mode.

    logs.write is the 'diagnostic' category, so it flows even in 'minimal' —
    matching the legacy 'diagnostics always flow' behavior.
    """
    try:
        from backend.apps.settings.store import load_settings
        s = load_settings()
        if getattr(s, "service_diagnostics_mode", None) == "minimal":
            return "minimal"
        if getattr(s, "service_diagnostics_mode", None) is None and not getattr(s, "analytics_opt_in", True):
            return "minimal"
    except Exception:
        pass
    return "full"


def get_analytics_client() -> Optional[AnalyticsClient]:
    """Lazily bootstrap + cache the client. Returns None if setup fails
    (e.g. offline first run) so callers can no-op safely."""
    global P_CLIENT
    if P_CLIENT is not None:
        return P_CLIENT
    try:
        from backend.apps.settings.store import load_settings, save_settings
        s = load_settings()
        install_id = getattr(s, "installation_id", None)
        if not install_id:
            return None  # main.py guarantees this at boot; bail defensively
        base_url = p_base_url()
        token = getattr(s, "analytics_token", None)
        if not token:
            token = AnalyticsClient.register(base_url=base_url, install_id=install_id)
            s.analytics_token = token
            save_settings(s)
        P_CLIENT = AnalyticsClient(base_url=base_url, token=token, mode=p_mode())
    except Exception as e:
        logger.debug("analytics setup failed (non-critical): %s", e)
        return None
    return P_CLIENT


def shutdown_analytics() -> None:
    global P_CLIENT
    if P_CLIENT is not None:
        try:
            P_CLIENT.flush(timeout=2.0)
            P_CLIENT.close()
        finally:
            P_CLIENT = None
```

---

### 5. Wire it into startup + shutdown — `backend/apps/service/service.py`

Inside `service_lifespan()`:

**At startup**, after `settings` is loaded (the existing startup try-block, near
where the legacy `sync({...})` calls fire), add the setup + single log write:

```python
        from backend.apps.service.analytics import get_analytics_client

        client = get_analytics_client()
        if client is not None:
            client.logs.write(
                tag="app",
                subtag="backend_started",
                data={"app_version": APP_VERSION},
            )
```

(`APP_VERSION` is already imported in `service.py`.)

**At shutdown**, after the existing task cancellation block (before the final
`logger.info("Service shut down")`), add:

```python
    from backend.apps.service.analytics import shutdown_analytics
    shutdown_analytics()
```

That's the whole first pass: one client, one log line, clean teardown.

---

## Verify the API names before wiring

The signatures below are current as of this doc, but they're generated from the
service — confirm against the installed package
(`swarm_analytics/client.py` and `swarm_analytics/_generated/endpoints.py`):

- `AnalyticsClient(base_url=..., token=..., mode=...)`
- `AnalyticsClient.register(base_url=..., install_id=...) -> str`
- `client.logs.write(tag: str, subtag: str | None = None, data: Any = None)`
- `client.flush(timeout)` / `client.close()`

---

## How to test it end to end

1. Run the **analytics service** from the analytics repo: `bash run.sh` (its
   `.env` puts the backend on `6792`).
2. Run the desktop backend; the default base URL already points at `6792`, so
   `bash run.sh` (from the desktop repo) is enough. To override, set
   `OPENSWARM_ANALYTICS_URL=http://127.0.0.1:<port> bash run.sh`.
3. On first boot you should see:
   - a new `analytics_token` saved into the desktop `settings.json`,
   - a `POST /public/identify/create_install_token` then a `POST /public/logs`
     hit the analytics service,
   - one `app / backend_started` row land in the analytics service's logs store.
4. Second boot should **not** call `create_install_token` again (token is reused).

### Acceptance criteria

- [ ] Desktop backend boots cleanly whether or not the analytics service is up
      (offline = no crash, no token saved, retried next boot).
- [ ] When the service is up: exactly one `backend_started` log row per boot.
- [ ] `register()` runs once total, not once per boot.
- [ ] No `install_id` / `user_id` / `ts` / `submission_id` is passed anywhere by
      hand (the SDK has no parameter for them).
