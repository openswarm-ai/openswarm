# Scheduling System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process asyncio scheduler that lets users create cron, interval, and one-shot schedules to fire agent sessions or message existing ones.

**Architecture:** Backend SubApp with JSON file storage + asyncio tick loop. Frontend Redux slice + MUI pages following existing patterns. `croniter` for cron parsing.

**Tech Stack:** Python/FastAPI (backend), React/Redux/MUI (frontend), croniter (cron parsing)

---

## File Structure

### Backend (Create)
- `backend/apps/schedules/__init__.py` — empty init
- `backend/apps/schedules/models.py` — Pydantic models (Schedule, ScheduleCreate, ScheduleUpdate)
- `backend/apps/schedules/schedules.py` — SubApp with CRUD endpoints
- `backend/apps/schedules/scheduler.py` — Background tick loop
- `backend/apps/schedules/executor.py` — Fire logic

### Backend (Modify)
- `backend/config/paths.py` — add `SCHEDULES_DIR`
- `backend/main.py` — register schedules SubApp
- `backend/apps/dashboards/dashboards.py` — cascade-delete schedules on dashboard delete

### Frontend (Create)
- `frontend/src/shared/state/schedulesSlice.ts` — Redux slice
- `frontend/src/app/pages/Schedules/Schedules.tsx` — Global schedules page
- `frontend/src/app/pages/Schedules/ScheduleEditor.tsx` — Create/edit dialog

### Frontend (Modify)
- `frontend/src/shared/state/store.ts` — register schedulesReducer
- `frontend/src/app/Main.tsx` — add `/schedules` route
- `frontend/src/app/components/Layout/AppShell.tsx` — add sidebar nav item + badge
- `frontend/src/shared/ws/WebSocketManager.ts` — handle schedule:* events

---

### Task 1: Install croniter and add SCHEDULES_DIR path

**Files:**
- Modify: `backend/config/paths.py`
- Modify: `backend/requirements.txt` (or equivalent)

- [ ] **Step 1: Add croniter dependency**

```bash
cd C:/Users/fireb/openswarm/backend
pip install croniter
```

Check if there's a requirements.txt or pyproject.toml:
```bash
ls C:/Users/fireb/openswarm/backend/requirements.txt C:/Users/fireb/openswarm/backend/pyproject.toml C:/Users/fireb/openswarm/pyproject.toml 2>/dev/null
```

Add `croniter` to whichever dependency file exists.

- [ ] **Step 2: Add SCHEDULES_DIR to paths.py**

In `backend/config/paths.py`, add:
```python
SCHEDULES_DIR = os.path.join(DATA_DIR, "schedules")
```

Place it alongside the existing `*_DIR` definitions (like `DASHBOARDS_DIR`, `SESSIONS_DIR`, etc.).

- [ ] **Step 3: Verify import works**

```bash
cd C:/Users/fireb/openswarm && python -c "from backend.config.paths import SCHEDULES_DIR; print(SCHEDULES_DIR)"
```

- [ ] **Step 4: Commit**

```bash
git add backend/config/paths.py
git commit -m "feat(schedules): add SCHEDULES_DIR path and croniter dependency"
```

---

### Task 2: Backend Pydantic models

**Files:**
- Create: `backend/apps/schedules/__init__.py`
- Create: `backend/apps/schedules/models.py`

- [ ] **Step 1: Create the schedules package**

Create `backend/apps/schedules/__init__.py` as an empty file.

- [ ] **Step 2: Create models.py**

Create `backend/apps/schedules/models.py`:

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

    # Trigger
    trigger_type: str  # "cron" | "interval" | "once"
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None

    # Action
    action_type: str  # "new_session" | "message_existing"
    prompt: str
    target_session_id: Optional[str] = None

    # Agent config (new_session only)
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None

    # State
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

- [ ] **Step 3: Verify models parse correctly**

```bash
cd C:/Users/fireb/openswarm && python -c "
from backend.apps.schedules.models import Schedule, ScheduleCreate, ScheduleUpdate
s = Schedule(dashboard_id='abc', trigger_type='cron', cron_expression='0 9 * * *', action_type='new_session', prompt='Hello')
print(s.model_dump(mode='json'))
"
```

- [ ] **Step 4: Commit**

```bash
git add backend/apps/schedules/__init__.py backend/apps/schedules/models.py
git commit -m "feat(schedules): add Pydantic models for Schedule, ScheduleCreate, ScheduleUpdate"
```

---

### Task 3: Backend executor

**Files:**
- Create: `backend/apps/schedules/executor.py`

- [ ] **Step 1: Create executor.py**

Create `backend/apps/schedules/executor.py`:

```python
import logging
from backend.apps.schedules.models import Schedule

logger = logging.getLogger(__name__)


async def execute_schedule(schedule: Schedule):
    """Fire a schedule: create a new session or message an existing one."""
    if schedule.action_type == "new_session":
        await _create_new_session(schedule)
    elif schedule.action_type == "message_existing":
        await _message_existing(schedule)
    else:
        raise ValueError(f"Unknown action_type: {schedule.action_type}")


async def _create_new_session(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.models import AgentConfig

    config_kwargs: dict = {
        "dashboard_id": schedule.dashboard_id,
    }

    if schedule.template_id:
        try:
            from backend.apps.templates.templates import _load as load_template
            template = load_template(schedule.template_id)
            if template.mode:
                config_kwargs["mode"] = template.mode
        except Exception:
            logger.warning(f"Template {schedule.template_id} not found, using defaults")

    if schedule.model:
        config_kwargs["model"] = schedule.model
    if schedule.mode:
        config_kwargs["mode"] = schedule.mode
    if schedule.system_prompt:
        config_kwargs["system_prompt"] = schedule.system_prompt

    config = AgentConfig(**config_kwargs)
    session = await agent_manager.launch_agent(config)

    await agent_manager.send_message(
        session.id,
        schedule.prompt,
        mode=config_kwargs.get("mode"),
        model=config_kwargs.get("model"),
    )

    logger.info(f"Schedule {schedule.id} created session {session.id}")


async def _message_existing(schedule: Schedule):
    from backend.apps.agents.agent_manager import agent_manager

    if not schedule.target_session_id:
        raise ValueError("target_session_id required for message_existing action")

    if schedule.target_session_id not in agent_manager.sessions:
        raise ValueError(f"Session {schedule.target_session_id} not found or not active")

    await agent_manager.send_message(
        schedule.target_session_id,
        schedule.prompt,
    )

    logger.info(f"Schedule {schedule.id} sent message to session {schedule.target_session_id}")
```

- [ ] **Step 2: Verify syntax**

```bash
cd C:/Users/fireb/openswarm && python -c "import py_compile; py_compile.compile('backend/apps/schedules/executor.py', doraise=True); print('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add backend/apps/schedules/executor.py
git commit -m "feat(schedules): add executor for firing new sessions and messaging existing ones"
```

---

### Task 4: Backend scheduler tick loop

**Files:**
- Create: `backend/apps/schedules/scheduler.py`

- [ ] **Step 1: Create scheduler.py**

Create `backend/apps/schedules/scheduler.py`:

```python
import asyncio
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

_scheduler_task: asyncio.Task | None = None
TICK_INTERVAL = 30


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

            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global("schedule:run_complete", {
                "schedule_id": schedule.id,
                "name": schedule.name,
            })
        except Exception as e:
            logger.exception(f"Schedule {schedule.id} ({schedule.name}) failed")
            schedule.last_error = str(e)

            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global("schedule:run_failed", {
                "schedule_id": schedule.id,
                "name": schedule.name,
                "error": str(e),
            })

        schedule.next_run_at = _compute_next_run(schedule, now)

        if schedule.trigger_type == "once":
            schedule.enabled = False

        schedule.updated_at = now
        _save(schedule)


def _compute_next_run(schedule, after: datetime) -> datetime | None:
    """Compute the next run time based on trigger type."""
    if schedule.trigger_type == "cron" and schedule.cron_expression:
        from croniter import croniter
        return croniter(schedule.cron_expression, after).get_next(datetime)
    elif schedule.trigger_type == "interval" and schedule.interval_seconds:
        return after + timedelta(seconds=schedule.interval_seconds)
    elif schedule.trigger_type == "once":
        return None
    return None


def compute_initial_next_run(schedule) -> datetime | None:
    """Compute the first next_run_at when a schedule is created."""
    if schedule.trigger_type == "cron" and schedule.cron_expression:
        from croniter import croniter
        return croniter(schedule.cron_expression, datetime.now()).get_next(datetime)
    elif schedule.trigger_type == "interval" and schedule.interval_seconds:
        return datetime.now() + timedelta(seconds=schedule.interval_seconds)
    elif schedule.trigger_type == "once" and schedule.run_at:
        return schedule.run_at
    return None


async def _run_loop():
    """Main scheduler loop — ticks every TICK_INTERVAL seconds."""
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("Scheduler tick failed")
        await asyncio.sleep(TICK_INTERVAL)


def start_scheduler():
    """Start the background scheduler task."""
    global _scheduler_task
    if _scheduler_task is None or _scheduler_task.done():
        loop = asyncio.get_event_loop()
        _scheduler_task = loop.create_task(_run_loop())
        logger.info("Scheduler started (tick interval: %ds)", TICK_INTERVAL)


def stop_scheduler():
    """Stop the background scheduler task."""
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        _scheduler_task = None
        logger.info("Scheduler stopped")
```

- [ ] **Step 2: Verify syntax**

```bash
cd C:/Users/fireb/openswarm && python -c "import py_compile; py_compile.compile('backend/apps/schedules/scheduler.py', doraise=True); print('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add backend/apps/schedules/scheduler.py
git commit -m "feat(schedules): add asyncio tick loop scheduler with croniter support"
```

---

### Task 5: Backend SubApp with CRUD endpoints

**Files:**
- Create: `backend/apps/schedules/schedules.py`
- Modify: `backend/main.py:1,26` — add import and register SubApp
- Modify: `backend/apps/dashboards/dashboards.py:209-238` — cascade delete schedules

- [ ] **Step 1: Create schedules.py**

Create `backend/apps/schedules/schedules.py`:

```python
import json
import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime

from backend.config.Apps import SubApp
from backend.apps.schedules.models import Schedule, ScheduleCreate, ScheduleUpdate
from backend.apps.schedules.scheduler import start_scheduler, stop_scheduler, compute_initial_next_run
from backend.config.paths import SCHEDULES_DIR as DATA_DIR
from fastapi import HTTPException, Query

logger = logging.getLogger(__name__)


def _load_all() -> list[Schedule]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Schedule(**json.load(f)))
    return result


def _save(schedule: Schedule):
    with open(os.path.join(DATA_DIR, f"{schedule.id}.json"), "w") as f:
        json.dump(schedule.model_dump(mode="json"), f, indent=2)


def _load(schedule_id: str) -> Schedule:
    path = os.path.join(DATA_DIR, f"{schedule_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Schedule not found")
    with open(path) as f:
        return Schedule(**json.load(f))


def _delete(schedule_id: str):
    path = os.path.join(DATA_DIR, f"{schedule_id}.json")
    if os.path.exists(path):
        os.remove(path)


def delete_schedules_for_dashboard(dashboard_id: str):
    """Remove all schedules tied to a dashboard. Called during dashboard deletion."""
    for schedule in _load_all():
        if schedule.dashboard_id == dashboard_id:
            _delete(schedule.id)
            logger.info(f"Deleted schedule {schedule.id} (dashboard {dashboard_id} deleted)")


@asynccontextmanager
async def schedules_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


schedules = SubApp("schedules", schedules_lifespan)


@schedules.router.get("/list")
async def list_schedules(dashboard_id: str | None = Query(None)):
    all_schedules = _load_all()
    if dashboard_id:
        all_schedules = [s for s in all_schedules if s.dashboard_id == dashboard_id]
    all_schedules.sort(key=lambda s: s.updated_at or s.created_at, reverse=True)
    return {"schedules": [s.model_dump(mode="json") for s in all_schedules]}


@schedules.router.post("/create")
async def create_schedule(body: ScheduleCreate):
    schedule = Schedule(
        name=body.name,
        dashboard_id=body.dashboard_id,
        trigger_type=body.trigger_type,
        cron_expression=body.cron_expression,
        interval_seconds=body.interval_seconds,
        run_at=body.run_at,
        action_type=body.action_type,
        prompt=body.prompt,
        target_session_id=body.target_session_id,
        template_id=body.template_id,
        model=body.model,
        mode=body.mode,
        system_prompt=body.system_prompt,
    )
    schedule.next_run_at = compute_initial_next_run(schedule)
    _save(schedule)
    return schedule.model_dump(mode="json")


@schedules.router.get("/{schedule_id}")
async def get_schedule(schedule_id: str):
    return _load(schedule_id).model_dump(mode="json")


@schedules.router.put("/{schedule_id}")
async def update_schedule(schedule_id: str, body: ScheduleUpdate):
    schedule = _load(schedule_id)
    trigger_changed = False

    for field_name in body.model_fields_set:
        value = getattr(body, field_name)
        setattr(schedule, field_name, value)
        if field_name in ("trigger_type", "cron_expression", "interval_seconds", "run_at"):
            trigger_changed = True

    if trigger_changed:
        schedule.next_run_at = compute_initial_next_run(schedule)

    schedule.updated_at = datetime.now()
    _save(schedule)
    return schedule.model_dump(mode="json")


@schedules.router.delete("/{schedule_id}")
async def delete_schedule_endpoint(schedule_id: str):
    _load(schedule_id)  # 404 if not found
    _delete(schedule_id)
    return {"ok": True}


@schedules.router.post("/{schedule_id}/toggle")
async def toggle_schedule(schedule_id: str):
    schedule = _load(schedule_id)
    schedule.enabled = not schedule.enabled

    if schedule.enabled and schedule.next_run_at is None:
        schedule.next_run_at = compute_initial_next_run(schedule)

    schedule.updated_at = datetime.now()
    _save(schedule)
    return schedule.model_dump(mode="json")
```

- [ ] **Step 2: Register in main.py**

In `backend/main.py`, add the import alongside other SubApp imports (around line 18):

```python
from backend.apps.schedules.schedules import schedules
```

Add `schedules` to the `MainApp` constructor list (line 26):

```python
main_app = MainApp([health, agents, templates, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, dashboards, schedules])
```

- [ ] **Step 3: Add cascade delete in dashboards.py**

In `backend/apps/dashboards/dashboards.py`, in the `delete_dashboard` function (around line 210), add schedule cleanup after the `_load(dashboard_id)` call:

```python
@dashboards.router.delete("/{dashboard_id}")
async def delete_dashboard(dashboard_id: str):
    _load(dashboard_id)

    # Delete schedules tied to this dashboard
    from backend.apps.schedules.schedules import delete_schedules_for_dashboard
    delete_schedules_for_dashboard(dashboard_id)

    if os.path.exists(SESSIONS_DIR):
        # ... rest of existing code unchanged
```

- [ ] **Step 4: Verify all backend files compile**

```bash
cd C:/Users/fireb/openswarm && python -c "
import py_compile
for f in ['backend/apps/schedules/schedules.py', 'backend/main.py', 'backend/apps/dashboards/dashboards.py']:
    py_compile.compile(f, doraise=True)
    print(f'{f}: OK')
"
```

- [ ] **Step 5: Commit**

```bash
git add backend/apps/schedules/schedules.py backend/main.py backend/apps/dashboards/dashboards.py
git commit -m "feat(schedules): add SubApp with CRUD endpoints, register in main, cascade delete on dashboard removal"
```

---

### Task 6: Frontend Redux slice

**Files:**
- Create: `frontend/src/shared/state/schedulesSlice.ts`
- Modify: `frontend/src/shared/state/store.ts` — register reducer

- [ ] **Step 1: Create schedulesSlice.ts**

Create `frontend/src/shared/state/schedulesSlice.ts`:

```typescript
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { API_BASE } from '@/shared/config';

const SCHEDULES_API = `${API_BASE}/schedules`;

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
  unreadCount: number;
}

const initialState: SchedulesState = {
  items: {},
  loading: false,
  unreadCount: 0,
};

export const fetchSchedules = createAsyncThunk(
  'schedules/fetchAll',
  async (dashboardId?: string) => {
    const url = dashboardId
      ? `${SCHEDULES_API}/list?dashboard_id=${dashboardId}`
      : `${SCHEDULES_API}/list`;
    const res = await fetch(url);
    const data = await res.json();
    return data.schedules as Schedule[];
  },
);

export const createSchedule = createAsyncThunk(
  'schedules/create',
  async (body: Omit<Schedule, 'id' | 'last_run_at' | 'next_run_at' | 'run_count' | 'last_error' | 'created_at' | 'updated_at' | 'enabled'> & { name?: string }) => {
    const res = await fetch(`${SCHEDULES_API}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Schedule;
  },
);

export const updateSchedule = createAsyncThunk(
  'schedules/update',
  async ({ id, ...body }: { id: string } & Partial<Schedule>) => {
    const res = await fetch(`${SCHEDULES_API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Schedule;
  },
);

export const deleteSchedule = createAsyncThunk(
  'schedules/delete',
  async (id: string) => {
    await fetch(`${SCHEDULES_API}/${id}`, { method: 'DELETE' });
    return id;
  },
);

export const toggleSchedule = createAsyncThunk(
  'schedules/toggle',
  async (id: string) => {
    const res = await fetch(`${SCHEDULES_API}/${id}/toggle`, { method: 'POST' });
    return (await res.json()) as Schedule;
  },
);

const schedulesSlice = createSlice({
  name: 'schedules',
  initialState,
  reducers: {
    incrementUnread(state) {
      state.unreadCount += 1;
    },
    clearUnread(state) {
      state.unreadCount = 0;
    },
    scheduleUpdatedFromWs(state, action: PayloadAction<{ schedule_id: string }>) {
      // Mark that we need to refetch — the schedule's state changed
      // We just increment unread as a signal
      state.unreadCount += 1;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSchedules.pending, (state) => {
        state.loading = true;
      })
      .addCase(fetchSchedules.fulfilled, (state, action) => {
        state.loading = false;
        const items: Record<string, Schedule> = {};
        for (const s of action.payload) {
          items[s.id] = s;
        }
        state.items = items;
      })
      .addCase(fetchSchedules.rejected, (state) => {
        state.loading = false;
      })
      .addCase(createSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(updateSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      })
      .addCase(deleteSchedule.fulfilled, (state, action) => {
        delete state.items[action.payload];
      })
      .addCase(toggleSchedule.fulfilled, (state, action) => {
        state.items[action.payload.id] = action.payload;
      });
  },
});

export const { incrementUnread, clearUnread, scheduleUpdatedFromWs } = schedulesSlice.actions;
export default schedulesSlice.reducer;
```

- [ ] **Step 2: Register in store.ts**

In `frontend/src/shared/state/store.ts`, add:

Import (after line 13):
```typescript
import schedulesReducer from './schedulesSlice';
```

Add to reducer object (after line 14, alongside `update: updateReducer`):
```typescript
schedules: schedulesReducer,
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd C:/Users/fireb/openswarm/frontend && npx tsc --noEmit --pretty 2>&1 | head -20
```

If tsc OOMs (known issue for this project), use:
```bash
cd C:/Users/fireb/openswarm/frontend && npx vite build 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/shared/state/schedulesSlice.ts frontend/src/shared/state/store.ts
git commit -m "feat(schedules): add Redux slice with CRUD thunks and unread tracking"
```

---

### Task 7: Frontend WebSocket event handling

**Files:**
- Modify: `frontend/src/shared/ws/WebSocketManager.ts:113-277` — add schedule event cases

- [ ] **Step 1: Add schedule event imports**

In `frontend/src/shared/ws/WebSocketManager.ts`, add to the imports at the top (after line 18):

```typescript
import { incrementUnread } from '../state/schedulesSlice';
```

- [ ] **Step 2: Add schedule event cases to handleMessage switch**

In the `handleMessage` method, add these cases before the closing of the switch block (before line 270, after the `dashboard:browser_card_added` case):

```typescript
      case 'schedule:run_complete':
        store.dispatch(incrementUnread());
        break;

      case 'schedule:run_failed':
        store.dispatch(incrementUnread());
        break;
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/shared/ws/WebSocketManager.ts
git commit -m "feat(schedules): handle schedule:run_complete and schedule:run_failed WebSocket events"
```

---

### Task 8: Frontend Schedules page

**Files:**
- Create: `frontend/src/app/pages/Schedules/Schedules.tsx`

- [ ] **Step 1: Create the Schedules directory and page**

Create `frontend/src/app/pages/Schedules/Schedules.tsx`:

```tsx
import React, { useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchSchedules,
  deleteSchedule,
  toggleSchedule,
  clearUnread,
  Schedule,
} from '@/shared/state/schedulesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import ScheduleEditor from './ScheduleEditor';

function formatTrigger(s: Schedule): string {
  if (s.trigger_type === 'cron' && s.cron_expression) return `Cron: ${s.cron_expression}`;
  if (s.trigger_type === 'interval' && s.interval_seconds) {
    if (s.interval_seconds >= 3600) return `Every ${Math.round(s.interval_seconds / 3600)}h`;
    if (s.interval_seconds >= 60) return `Every ${Math.round(s.interval_seconds / 60)}m`;
    return `Every ${s.interval_seconds}s`;
  }
  if (s.trigger_type === 'once' && s.run_at) return `Once: ${new Date(s.run_at).toLocaleString()}`;
  return s.trigger_type;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

const Schedules: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.schedules.items);
  const dashboards = useAppSelector((s) => s.dashboards.items);
  const loading = useAppSelector((s) => s.schedules.loading);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const scheduleList = Object.values(items).sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  useEffect(() => {
    dispatch(fetchSchedules());
    dispatch(clearUnread());
  }, [dispatch]);

  const handleEdit = (id: string) => {
    setEditingId(id);
    setEditorOpen(true);
  };

  const handleCreate = () => {
    setEditingId(null);
    setEditorOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await dispatch(deleteSchedule(id)).unwrap();
    } catch (e: any) {
      setDeleteError(e.message || 'Failed to delete schedule');
    }
  };

  const handleToggle = (id: string) => {
    dispatch(toggleSchedule(id));
  };

  return (
    <Box sx={{ width: '100%', height: '100%', bgcolor: c.bg.page, color: c.text.primary, p: 3, overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>Schedules</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate} sx={{ bgcolor: c.accent.primary }}>
          New Schedule
        </Button>
      </Box>

      {scheduleList.length === 0 && !loading ? (
        <Typography sx={{ color: c.text.muted }}>No schedules yet. Create one to get started.</Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Trigger</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Dashboard</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Status</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Next Run</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Last Run</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }}>Runs</TableCell>
                <TableCell sx={{ color: c.text.secondary, fontWeight: 600 }} align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {scheduleList.map((s) => (
                <TableRow key={s.id} hover>
                  <TableCell sx={{ color: c.text.primary }}>{s.name}</TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatTrigger(s)}</TableCell>
                  <TableCell sx={{ color: c.text.muted }}>
                    {dashboards[s.dashboard_id]?.name || s.dashboard_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {s.last_error ? (
                      <Tooltip title={s.last_error}>
                        <Chip label="Error" size="small" sx={{ bgcolor: c.status.errorBg, color: c.status.error, fontWeight: 600 }} />
                      </Tooltip>
                    ) : s.enabled ? (
                      <Chip label="Active" size="small" sx={{ bgcolor: c.status.successBg, color: c.status.success, fontWeight: 600 }} />
                    ) : (
                      <Chip label="Paused" size="small" sx={{ bgcolor: c.status.warningBg, color: c.status.warning, fontWeight: 600 }} />
                    )}
                  </TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatDate(s.next_run_at)}</TableCell>
                  <TableCell sx={{ color: c.text.muted, fontSize: '0.85rem' }}>{formatDate(s.last_run_at)}</TableCell>
                  <TableCell sx={{ color: c.text.muted }}>{s.run_count}</TableCell>
                  <TableCell align="right">
                    <Tooltip title={s.enabled ? 'Pause' : 'Resume'}>
                      <IconButton size="small" onClick={() => handleToggle(s.id)} sx={{ color: c.text.muted }}>
                        {s.enabled ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => handleEdit(s.id)} sx={{ color: c.text.muted }}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => handleDelete(s.id)} sx={{ color: c.text.muted }}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ScheduleEditor
        open={editorOpen}
        scheduleId={editingId}
        onClose={() => { setEditorOpen(false); setEditingId(null); }}
      />

      <Snackbar open={!!deleteError} autoHideDuration={4000} onClose={() => setDeleteError(null)}>
        <Alert severity="error" onClose={() => setDeleteError(null)}>{deleteError}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Schedules;
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/app/pages/Schedules/Schedules.tsx
git commit -m "feat(schedules): add global Schedules page with table view and status chips"
```

---

### Task 9: Frontend Schedule Editor dialog

**Files:**
- Create: `frontend/src/app/pages/Schedules/ScheduleEditor.tsx`

- [ ] **Step 1: Create ScheduleEditor.tsx**

Create `frontend/src/app/pages/Schedules/ScheduleEditor.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createSchedule, updateSchedule, fetchSchedules } from '@/shared/state/schedulesSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface Props {
  open: boolean;
  scheduleId: string | null;
  onClose: () => void;
}

const TRIGGER_TYPES = [
  { value: 'cron', label: 'Cron Expression' },
  { value: 'interval', label: 'Interval' },
  { value: 'once', label: 'One-shot' },
];

const ACTION_TYPES = [
  { value: 'new_session', label: 'Create New Session' },
  { value: 'message_existing', label: 'Message Existing Session' },
];

const ScheduleEditor: React.FC<Props> = ({ open, scheduleId, onClose }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const existing = useAppSelector((s) => scheduleId ? s.schedules.items[scheduleId] : null);
  const dashboards = useAppSelector((s) => s.dashboards.items);
  const templates = useAppSelector((s) => s.templates.items);
  const dashboardList = Object.values(dashboards);
  const templateList = Object.values(templates);

  const [name, setName] = useState('');
  const [dashboardId, setDashboardId] = useState('');
  const [triggerType, setTriggerType] = useState('cron');
  const [cronExpression, setCronExpression] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [runAt, setRunAt] = useState('');
  const [actionType, setActionType] = useState('new_session');
  const [prompt, setPrompt] = useState('');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [model, setModel] = useState('sonnet');
  const [mode, setMode] = useState('agent');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [configSource, setConfigSource] = useState<'template' | 'inline'>('inline');

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDashboardId(existing.dashboard_id);
      setTriggerType(existing.trigger_type);
      setCronExpression(existing.cron_expression || '');
      setIntervalSeconds(existing.interval_seconds || 3600);
      setRunAt(existing.run_at || '');
      setActionType(existing.action_type);
      setPrompt(existing.prompt);
      setTargetSessionId(existing.target_session_id || '');
      setTemplateId(existing.template_id || '');
      setModel(existing.model || 'sonnet');
      setMode(existing.mode || 'agent');
      setSystemPrompt(existing.system_prompt || '');
      setConfigSource(existing.template_id ? 'template' : 'inline');
    } else {
      setName('');
      setDashboardId(dashboardList[0]?.id || '');
      setTriggerType('cron');
      setCronExpression('');
      setIntervalSeconds(3600);
      setRunAt('');
      setActionType('new_session');
      setPrompt('');
      setTargetSessionId('');
      setTemplateId('');
      setModel('sonnet');
      setMode('agent');
      setSystemPrompt('');
      setConfigSource('inline');
    }
  }, [existing, open]);

  const inputSx = {
    '& .MuiOutlinedInput-root': {
      color: c.text.primary,
      '& fieldset': { borderColor: c.border.strong },
      '&:hover fieldset': { borderColor: c.text.tertiary },
      '&.Mui-focused fieldset': { borderColor: c.accent.primary },
    },
    '& .MuiInputLabel-root': { color: c.text.tertiary },
    '& .MuiInputLabel-root.Mui-focused': { color: c.accent.primary },
  };

  const handleSave = async () => {
    const body: any = {
      name: name || 'Untitled Schedule',
      dashboard_id: dashboardId,
      trigger_type: triggerType,
      action_type: actionType,
      prompt,
    };

    if (triggerType === 'cron') body.cron_expression = cronExpression;
    if (triggerType === 'interval') body.interval_seconds = intervalSeconds;
    if (triggerType === 'once') body.run_at = runAt;

    if (actionType === 'message_existing') {
      body.target_session_id = targetSessionId;
    } else if (configSource === 'template') {
      body.template_id = templateId;
    } else {
      body.model = model;
      body.mode = mode;
      if (systemPrompt) body.system_prompt = systemPrompt;
    }

    if (scheduleId) {
      await dispatch(updateSchedule({ id: scheduleId, ...body }));
    } else {
      await dispatch(createSchedule(body));
    }

    dispatch(fetchSchedules());
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { bgcolor: c.bg.surface, borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
    >
      <DialogTitle sx={{ color: c.text.primary, fontWeight: 700 }}>
        {scheduleId ? 'Edit Schedule' : 'New Schedule'}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth size="small" sx={inputSx} />

        <TextField
          select label="Dashboard" value={dashboardId}
          onChange={(e) => setDashboardId(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {dashboardList.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>

        <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Trigger</Typography>

        <TextField
          select label="Type" value={triggerType}
          onChange={(e) => setTriggerType(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {TRIGGER_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>

        {triggerType === 'cron' && (
          <TextField
            label="Cron Expression" value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)} fullWidth size="small" sx={inputSx}
            helperText="e.g. 0 9 * * * (every day at 9am)"
          />
        )}
        {triggerType === 'interval' && (
          <TextField
            label="Interval (seconds)" type="number" value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))} fullWidth size="small" sx={inputSx}
            helperText="e.g. 3600 = every hour"
          />
        )}
        {triggerType === 'once' && (
          <TextField
            label="Run At" type="datetime-local" value={runAt}
            onChange={(e) => setRunAt(e.target.value)} fullWidth size="small" sx={inputSx}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}

        <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Action</Typography>

        <TextField
          select label="Action Type" value={actionType}
          onChange={(e) => setActionType(e.target.value)} fullWidth size="small" sx={inputSx}
          SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
        >
          {ACTION_TYPES.map((a) => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}
        </TextField>

        <TextField
          label="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          fullWidth size="small" multiline minRows={3} sx={inputSx}
        />

        {actionType === 'message_existing' && (
          <TextField
            label="Target Session ID" value={targetSessionId}
            onChange={(e) => setTargetSessionId(e.target.value)} fullWidth size="small" sx={inputSx}
          />
        )}

        {actionType === 'new_session' && (
          <>
            <Typography variant="subtitle2" sx={{ color: c.text.secondary, mt: 1 }}>Agent Config</Typography>

            <TextField
              select label="Config Source" value={configSource}
              onChange={(e) => setConfigSource(e.target.value as 'template' | 'inline')}
              fullWidth size="small" sx={inputSx}
              SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
            >
              <MenuItem value="inline">Configure Inline</MenuItem>
              <MenuItem value="template">Use Template</MenuItem>
            </TextField>

            {configSource === 'template' ? (
              <TextField
                select label="Template" value={templateId}
                onChange={(e) => setTemplateId(e.target.value)} fullWidth size="small" sx={inputSx}
                SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
              >
                {templateList.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
              </TextField>
            ) : (
              <>
                <TextField
                  select label="Model" value={model}
                  onChange={(e) => setModel(e.target.value)} fullWidth size="small" sx={inputSx}
                  SelectProps={{ MenuProps: { PaperProps: { sx: { bgcolor: c.bg.surface } } } }}
                >
                  <MenuItem value="sonnet">Sonnet</MenuItem>
                  <MenuItem value="haiku">Haiku</MenuItem>
                  <MenuItem value="opus">Opus</MenuItem>
                </TextField>

                <TextField
                  label="Mode" value={mode}
                  onChange={(e) => setMode(e.target.value)} fullWidth size="small" sx={inputSx}
                />

                <TextField
                  label="System Prompt (optional)" value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  fullWidth size="small" multiline minRows={2} sx={inputSx}
                />
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ color: c.text.muted }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!prompt || !dashboardId} sx={{ bgcolor: c.accent.primary }}>
          {scheduleId ? 'Save' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ScheduleEditor;
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/app/pages/Schedules/ScheduleEditor.tsx
git commit -m "feat(schedules): add ScheduleEditor dialog with trigger/action/config forms"
```

---

### Task 10: Frontend routing, sidebar, and notification toast

**Files:**
- Modify: `frontend/src/app/Main.tsx:220-231` — add route
- Modify: `frontend/src/app/components/Layout/AppShell.tsx:49-54` — add sidebar item with badge

- [ ] **Step 1: Add route in Main.tsx**

In `frontend/src/app/Main.tsx`, add the import (after line 24):

```typescript
import Schedules from './pages/Schedules/Schedules';
```

Add the route inside the `<Route element={<AppShell />}>` block (after the `/apps/:id` route, around line 230):

```tsx
<Route path="/schedules" element={<Schedules />} />
```

- [ ] **Step 2: Add sidebar nav item in AppShell.tsx**

In `frontend/src/app/components/Layout/AppShell.tsx`, add the import (alongside other icon imports):

```typescript
import ScheduleIcon from '@mui/icons-material/Schedule';
import Badge from '@mui/material/Badge';
```

Add schedule to the `CUSTOMIZATION_ITEMS` array (line 49-54):

```typescript
const CUSTOMIZATION_ITEMS = [
  { label: 'Prompts', path: '/templates', icon: <DescriptionIcon /> },
  { label: 'Skills', path: '/skills', icon: <PsychologyIcon /> },
  { label: 'Actions', path: '/actions', icon: <BuildIcon /> },
  { label: 'Modes', path: '/modes', icon: <TuneIcon /> },
  { label: 'Schedules', path: '/schedules', icon: <ScheduleIcon /> },
];
```

The badge for unread count needs to be wired where sidebar items are rendered. Find the section where `CUSTOMIZATION_ITEMS` are mapped and wrap the icon for Schedules in a `Badge` component. Look for something like:

```tsx
{CUSTOMIZATION_ITEMS.map((item) => (
  <ListItemButton key={item.path} component={NavLink} to={item.path} ...>
    <ListItemIcon>
      {item.label === 'Schedules' ? (
        <Badge badgeContent={unreadCount} color="error" max={99}>
          {item.icon}
        </Badge>
      ) : item.icon}
    </ListItemIcon>
    <ListItemText primary={item.label} />
  </ListItemButton>
))}
```

Add the selector at the top of the AppShell component:
```typescript
const scheduleUnread = useAppSelector((s) => s.schedules.unreadCount);
```

- [ ] **Step 3: Add failure toast in AppShell.tsx**

Add state and a Snackbar for schedule failures. In the AppShell component:

```typescript
const [scheduleError, setScheduleError] = useState<string | null>(null);

useEffect(() => {
  const unsub = dashboardWs.on('schedule:run_failed', (data: any) => {
    setScheduleError(`Schedule "${data.name}" failed: ${data.error}`);
  });
  return unsub;
}, []);
```

Add the Snackbar JSX (alongside existing Snackbar elements):

```tsx
<Snackbar
  open={!!scheduleError}
  autoHideDuration={6000}
  onClose={() => setScheduleError(null)}
  anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
>
  <Alert severity="error" onClose={() => setScheduleError(null)}>{scheduleError}</Alert>
</Snackbar>
```

Import `dashboardWs` if not already imported:
```typescript
import { dashboardWs } from '@/shared/ws/WebSocketManager';
```

- [ ] **Step 4: Verify build**

```bash
cd C:/Users/fireb/openswarm/frontend && npx vite build 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/Main.tsx frontend/src/app/components/Layout/AppShell.tsx
git commit -m "feat(schedules): add /schedules route, sidebar nav with badge, failure toast"
```

---

### Task 11: Integration test — end to end

**Files:** None (manual testing)

- [ ] **Step 1: Start the app**

```bash
cd C:/Users/fireb/openswarm && npm start
```

- [ ] **Step 2: Verify backend endpoints**

Test CRUD via curl:
```bash
# List (empty)
curl http://127.0.0.1:8324/api/schedules/list

# Create
curl -X POST http://127.0.0.1:8324/api/schedules/create \
  -H "Content-Type: application/json" \
  -d '{"dashboard_id":"REPLACE_WITH_REAL_ID","trigger_type":"interval","interval_seconds":60,"action_type":"new_session","prompt":"Hello from scheduler","name":"Test Schedule"}'

# List (should show 1)
curl http://127.0.0.1:8324/api/schedules/list

# Toggle
curl -X POST http://127.0.0.1:8324/api/schedules/SCHEDULE_ID/toggle

# Delete
curl -X DELETE http://127.0.0.1:8324/api/schedules/SCHEDULE_ID
```

- [ ] **Step 3: Verify frontend**

1. Navigate to `/#/schedules` in the app
2. Verify the page loads with "New Schedule" button
3. Click "New Schedule", fill in the form, create
4. Verify the schedule appears in the table
5. Test pause/resume toggle
6. Test edit
7. Test delete
8. Verify sidebar shows "Schedules" nav item

- [ ] **Step 4: Verify scheduler fires**

Create an interval schedule with 60-second interval. Wait ~90 seconds. Verify:
- A new agent session appears in the target dashboard
- The schedule's `run_count` increments
- The `last_run_at` field updates

- [ ] **Step 5: Commit any fixes needed**

```bash
git add -A && git commit -m "fix(schedules): integration test fixes"
```
