# OpenSwarm Scheduling System Design

## Summary

An in-process asyncio scheduler that lets users create recurring (cron), interval, and one-shot schedules to fire agent sessions or send messages to existing sessions. Schedules are tied to dashboards and persist as JSON files following the existing SubApp pattern. Uses `croniter` for cron expression parsing.

Inspired by OpenClaw's approach: simple in-process tick loop + JSON persistence, no external dependencies.

## Requirements

1. **Three trigger types:** cron expressions (`0 9 * * *`), interval (every N seconds), one-shot (run at specific datetime)
2. **Two action types:** create a new agent session, or send a message to an existing session
3. **Agent configuration:** pick a template OR configure inline (model, mode, system prompt)
4. **Dashboard-bound:** each schedule is tied to a dashboard — new sessions appear in that dashboard
5. **Pause/resume:** schedules can be temporarily disabled without deletion
6. **UI locations:** global Schedules page (all schedules) + per-dashboard filtered view
7. **Notifications:** badge on Schedules sidebar icon for new results; toast popup on failures only
8. **CLI routing:** all LLM calls go through `llm_router` — works with API key or Claude Code CLI auth

---

## Data Model

### Backend: `backend/apps/schedules/models.py`

```python
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import uuid4


class Schedule(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Schedule"
    enabled: bool = True
    dashboard_id: str

    # Trigger configuration
    trigger_type: str  # "cron" | "interval" | "once"
    cron_expression: Optional[str] = None       # e.g. "0 9 * * *"
    interval_seconds: Optional[int] = None      # e.g. 3600
    run_at: Optional[datetime] = None           # one-shot ISO timestamp

    # Action configuration
    action_type: str  # "new_session" | "message_existing"
    prompt: str
    target_session_id: Optional[str] = None     # for message_existing

    # Agent configuration (new_session only)
    template_id: Optional[str] = None           # use a template
    model: Optional[str] = None                 # inline: "sonnet", "haiku", etc.
    mode: Optional[str] = None                  # inline: mode name
    system_prompt: Optional[str] = None         # inline: custom system prompt

    # State tracking
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    run_count: int = 0
    last_error: Optional[str] = None

    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class ScheduleCreate(BaseModel):
    name: str = "Untitled Schedule"
    dashboard_id: str
    trigger_type: str
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None
    action_type: str
    prompt: str
    target_session_id: Optional[str] = None
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None


class ScheduleUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    dashboard_id: Optional[str] = None
    trigger_type: Optional[str] = None
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None
    action_type: Optional[str] = None
    prompt: Optional[str] = None
    target_session_id: Optional[str] = None
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None
```

### Frontend: `frontend/src/shared/state/schedulesSlice.ts`

```typescript
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  dashboard_id: string;
  trigger_type: 'cron' | 'interval' | 'once';
  cron_expression: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  action_type: 'new_session' | 'message_existing';
  prompt: string;
  target_session_id: string | null;
  template_id: string | null;
  model: string | null;
  mode: string | null;
  system_prompt: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SchedulesState {
  items: Record<string, Schedule>;
  loading: boolean;
  unreadCount: number;  // for badge
}
```

---

## Backend Architecture

### File Structure

```
backend/apps/schedules/
├── __init__.py
├── models.py          # Pydantic models (above)
├── schedules.py       # SubApp + CRUD endpoints
├── scheduler.py       # Background tick loop
└── executor.py        # Fire logic (new session / message existing)
```

### Storage

- Directory: add `SCHEDULES_DIR` to `backend/config/paths.py`
- One JSON file per schedule: `{SCHEDULES_DIR}/{schedule_id}.json`
- Same pattern as `backend/apps/dashboards/dashboards.py`

### SubApp: `schedules.py`

Follows the exact pattern of `dashboards.py`:

- `_load_all() -> list[Schedule]`
- `_save(schedule: Schedule)`
- `_load(schedule_id: str) -> Schedule`
- `_delete(schedule_id: str)`
- Lifespan: `os.makedirs(DATA_DIR, exist_ok=True)`, start scheduler background task

**Endpoints (all under `/api/schedules/`):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/list` | List all schedules |
| GET | `/list?dashboard_id={id}` | List schedules for a dashboard |
| POST | `/create` | Create a new schedule |
| GET | `/{id}` | Get single schedule |
| PUT | `/{id}` | Update schedule |
| DELETE | `/{id}` | Delete schedule |
| POST | `/{id}/toggle` | Toggle enabled/disabled |

### Scheduler: `scheduler.py`

```python
import asyncio
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

_scheduler_task: asyncio.Task | None = None
TICK_INTERVAL = 30  # seconds


async def _tick():
    """One evaluation cycle: check all enabled schedules, fire due ones."""
    from backend.apps.schedules.schedules import _load_all, _save
    from backend.apps.schedules.executor import execute_schedule

    now = datetime.now()
    for schedule in _load_all():
        if not schedule.enabled:
            continue
        if schedule.next_run_at is None:
            continue
        if schedule.next_run_at > now:
            continue

        try:
            await execute_schedule(schedule)
            schedule.last_run_at = now
            schedule.run_count += 1
            schedule.last_error = None
        except Exception as e:
            logger.exception(f"Schedule {schedule.id} failed")
            schedule.last_error = str(e)
            # Emit failure WebSocket event
            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global({
                "event": "schedule:run_failed",
                "data": {"schedule_id": schedule.id, "name": schedule.name, "error": str(e)},
            })

        # Compute next_run_at
        schedule.next_run_at = _compute_next_run(schedule, now)

        # Auto-disable one-shot after firing
        if schedule.trigger_type == "once":
            schedule.enabled = False

        schedule.updated_at = now
        _save(schedule)

        # Emit success WebSocket event
        if schedule.last_error is None:
            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global({
                "event": "schedule:run_complete",
                "data": {"schedule_id": schedule.id, "name": schedule.name},
            })


def _compute_next_run(schedule, after: datetime) -> datetime | None:
    if schedule.trigger_type == "cron" and schedule.cron_expression:
        from croniter import croniter
        return croniter(schedule.cron_expression, after).get_next(datetime)
    elif schedule.trigger_type == "interval" and schedule.interval_seconds:
        from datetime import timedelta
        return after + timedelta(seconds=schedule.interval_seconds)
    elif schedule.trigger_type == "once":
        return None  # already fired
    return None


async def _run_loop():
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("Scheduler tick failed")
        await asyncio.sleep(TICK_INTERVAL)


def start_scheduler():
    global _scheduler_task
    if _scheduler_task is None or _scheduler_task.done():
        _scheduler_task = asyncio.get_event_loop().create_task(_run_loop())
        logger.info("Scheduler started")


def stop_scheduler():
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        logger.info("Scheduler stopped")
```

### Executor: `executor.py`

```python
import logging
from backend.apps.schedules.models import Schedule

logger = logging.getLogger(__name__)


async def execute_schedule(schedule: Schedule):
    """Fire a schedule: either create a new session or message an existing one."""
    from backend.apps.agents.agent_manager import agent_manager

    if schedule.action_type == "new_session":
        await _create_new_session(schedule)
    elif schedule.action_type == "message_existing":
        await _message_existing(schedule)


async def _create_new_session(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager

    # Build session config from template or inline
    config = {}
    if schedule.template_id:
        from backend.apps.templates.templates import _load as load_template
        template = load_template(schedule.template_id)
        config["mode"] = template.mode
        config["model"] = template.model
        config["system_prompt"] = template.system_prompt
    else:
        if schedule.model:
            config["model"] = schedule.model
        if schedule.mode:
            config["mode"] = schedule.mode
        if schedule.system_prompt:
            config["system_prompt"] = schedule.system_prompt

    session = await agent_manager.create_session(
        dashboard_id=schedule.dashboard_id,
        **config,
    )

    await agent_manager.send_message(
        session.id,
        schedule.prompt,
        mode=config.get("mode"),
        model=config.get("model"),
    )


async def _message_existing(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager

    if not schedule.target_session_id:
        raise ValueError("target_session_id required for message_existing")

    if schedule.target_session_id not in agent_manager.sessions:
        raise ValueError(f"Session {schedule.target_session_id} not found")

    await agent_manager.send_message(
        schedule.target_session_id,
        schedule.prompt,
    )
```

### Registration

**`backend/config/paths.py`** — add:
```python
SCHEDULES_DIR = os.path.join(DATA_DIR, "schedules")
```

**`backend/main.py`** — add to imports and `MainApp` list:
```python
from backend.apps.schedules.schedules import schedules
# Add to MainApp constructor list
```

---

## Frontend Architecture

### File Structure

```
frontend/src/
├── shared/state/schedulesSlice.ts        # Redux slice
├── app/pages/Schedules/Schedules.tsx     # Global schedules page
├── app/pages/Schedules/ScheduleEditor.tsx # Create/edit dialog
└── app/pages/Dashboard/SchedulePanel.tsx  # Per-dashboard schedule list
```

### Redux Slice: `schedulesSlice.ts`

Follows `dashboardsSlice.ts` pattern exactly:
- `fetchSchedules` — GET `/api/schedules/list`
- `createSchedule` — POST `/api/schedules/create`
- `updateSchedule` — PUT `/api/schedules/{id}`
- `deleteSchedule` — DELETE `/api/schedules/{id}`
- `toggleSchedule` — POST `/api/schedules/{id}/toggle`
- `incrementUnread` — reducer for WebSocket events
- `clearUnread` — reducer when user views schedules page

Register in `store.ts`:
```typescript
import schedulesReducer from './schedulesSlice';
// Add: schedules: schedulesReducer
```

### Global Schedules Page: `Schedules.tsx`

Standard page layout matching Settings/Templates pattern:
- `useClaudeTokens()` for theming
- `useAppDispatch()` + `useAppSelector()` for state
- Full-height `Box` with `c.bg.page`
- Table/list of all schedules with columns: Name, Trigger, Dashboard, Status (Chip), Next Run, Last Run, Actions
- Status `Chip`: green "Active", orange "Paused", red "Error"
- Action buttons: Edit (opens ScheduleEditor dialog), Toggle (pause/resume), Delete
- "New Schedule" button at top

### Schedule Editor: `ScheduleEditor.tsx`

MUI `Dialog` following existing modal patterns:
- Trigger type selector (cron / interval / once)
- Conditional fields based on trigger type:
  - Cron: text field for expression with helper text
  - Interval: number field for seconds
  - Once: datetime picker
- Action type selector (new session / message existing)
- Conditional fields:
  - New session: template dropdown OR inline config (model select, mode select, system prompt textarea)
  - Message existing: session ID picker (from dashboard's active sessions)
- Dashboard picker dropdown
- Prompt textarea
- Name field

All inputs use the existing `inputSx` pattern with `c.border.strong`, `c.text.tertiary`, `c.accent.primary`.

### Per-Dashboard Panel: `SchedulePanel.tsx`

Compact list filtered to the current dashboard. Shown as a collapsible section or tab within the Dashboard page. Same data, simpler layout — just name, status chip, next run, and toggle/edit buttons.

### Sidebar Navigation

Add to `AppShell.tsx`:
```tsx
import ScheduleIcon from '@mui/icons-material/Schedule';

// In CUSTOMIZATION_ITEMS or as a standalone nav item:
{ label: 'Schedules', path: '/schedules', icon: <ScheduleIcon /> }
```

Badge on the sidebar icon shows `unreadCount` from Redux state.

### Route

Add to `Main.tsx`:
```tsx
import Schedules from './pages/Schedules/Schedules';
// In Routes:
<Route path="/schedules" element={<Schedules />} />
```

### WebSocket Notifications

In the existing WebSocket handler (`frontend/src/shared/ws/`), listen for:
- `schedule:run_complete` — increment `unreadCount` in schedulesSlice
- `schedule:run_failed` — increment `unreadCount` + show Snackbar toast with error

---

## WebSocket Events

### Backend → Frontend

| Event | Data | Purpose |
|-------|------|---------|
| `schedule:run_complete` | `{ schedule_id, name }` | Badge increment |
| `schedule:run_failed` | `{ schedule_id, name, error }` | Badge + failure toast |

Sent via `ws_manager.broadcast_global()` on the dashboard WebSocket channel.

---

## Dependencies

- **`croniter`** — Python package for cron expression parsing (pip install)
- No new frontend dependencies — all MUI

---

## Edge Cases

1. **Backend restart:** Scheduler starts in SubApp lifespan. On startup, recompute `next_run_at` for all enabled schedules from persisted state. Missed runs during downtime are skipped (not retroactively fired).
2. **One-shot in the past:** If `run_at` is in the past when created, fire immediately on next tick, then disable.
3. **Target session deleted:** `message_existing` action fails gracefully — logged as error in `last_error`, toast sent.
4. **Dashboard deleted:** Cascade-delete all schedules tied to that dashboard (same as session cleanup in `dashboards.py`).
5. **Concurrent ticks:** Not an issue — single-process asyncio, one tick at a time.
