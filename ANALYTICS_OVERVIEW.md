# Analytics Overview (`swarm-analytics` SDK)

This document explains how the OpenSwarm product-analytics system works and how
to use the `swarm-analytics` Python SDK to send analytics from the desktop app.
It is written for an engineer/agent integrating the SDK into a separate codebase.

---

## 1. The big picture

- There is a standalone **analytics ingest service** (a FastAPI app, the
  `product-analytics-v1` repo). It exposes a small set of **typed POST
  endpoints** under `/public/*` — one per event category.
- The **desktop app's Python backend is the single network egress** for
  analytics. The React frontend never talks to the analytics service directly;
  if the UI needs to record something it hands it to the local backend, which
  forwards it. (This doc only covers the backend SDK.)
- The backend talks to the service through the **`swarm-analytics` pip
  package** — a typed client that is **auto-generated from the service's own
  pydantic models**, so the client validates payloads against the *exact* schema
  the server enforces. If a call would be rejected by the server for being the
  wrong shape, it fails locally first, as a `pydantic.ValidationError`, before
  any network I/O.

### Why it's "impossible to call wrong"

- **Identity is never passed by the caller.** No method takes `install_id` or
  `user_id`. The server resolves identity from the **bearer token** on every
  request. There is no way to spoof or forget it.
- **Per-request metadata is auto-filled.** `ts` (client timestamp) and
  `submission_id` (idempotency UUID) never appear in any method signature — the
  transport stamps them automatically.
- **Enums are `Literal`s.** Fields like `action` and `status` only accept their
  allowed values; a typo raises immediately.
- **Models are vendored verbatim** from the service, so client and server can't
  drift (a generator + drift check guard this).

---

## 2. How a call flows (sync validate, async deliver)

The public API is **fully synchronous and fire-and-forget**:

1. You call e.g. `client.logs.write(tag="app", subtag="started")`.
2. On the **calling thread**, the payload is validated against the pydantic
   model. Bad input raises `pydantic.ValidationError` *here, in your stack*.
3. A serialized record is handed to a **background worker thread** which does the
   actual HTTP POST, with retries and exponential backoff.
4. The call returns immediately. It never blocks on the network and (after
   validation) never raises for delivery problems.

**Idempotency:** `submission_id` is minted once at enqueue time and reused on
every retry (including replays from a durable spool after a restart). The server
dedups on `(install_id, submission_id)`, so retries are no-ops, never
double-writes.

**Retry policy (handled for you):**
- `2xx` → success.
- `429` and `5xx` → retried with backoff (up to `max_attempts`, default 8).
- other `4xx` → permanent (bad data); dropped, not retried.
- network/timeout errors → retried.

---

## 3. Install

```bash
pip install swarm-analytics
```

(Or `pip install ./sdk` from the analytics repo root for a local build.)

---

## 4. Bootstrap: minting a token (`register`)

A fresh install has no token. `register()` is the **one unauthenticated,
blocking** call — it mints an install token from an `install_id` you own.

```python
from swarm_analytics import AnalyticsClient

token = AnalyticsClient.register(
    base_url="https://analytics.example.com",
    install_id=install_id,        # your app's stable per-install UUID
)
# Persist `token`. Reuse it on every subsequent run — never call register again
# once you have a token.
```

- It POSTs to `/public/identify/create_install_token`.
- Raises `AuthError` on 401, `TransportError` on other failures (and on network
  errors). Wrap it if you need to survive being offline on first launch.

---

## 5. Constructing the client

```python
from swarm_analytics import AnalyticsClient

client = AnalyticsClient(
    base_url="https://analytics.example.com",
    token=token,                 # from register(), persisted
    mode="full",                 # or "minimal" (see opt-out below)
)
```

Constructor options:

| Arg            | Default            | Meaning                                                        |
| -------------- | ------------------ | -------------------------------------------------------------- |
| `base_url`     | (required)         | Root URL of the analytics service.                             |
| `token`        | (required)         | Install token from `register()`.                               |
| `mode`         | `"full"`           | `"minimal"` mutes product telemetry (see §7).                  |
| `spool`        | `None`             | Optional durable store for crash/offline survival (see §8).    |
| `max_attempts` | `8`                | Retry cap per record before it's dropped.                      |
| `on_drop`      | `None`             | Callback `(record, status)` when a record is permanently dropped. |

The client starts a daemon worker thread on construction. Build **one client per
process** and reuse it (a module-level singleton is ideal).

---

## 6. The full API surface

Every method is keyword-only and returns `None`. Identity, `ts`, and
`submission_id` are intentionally absent — they're handled for you.

### Logs (diagnostics)

```python
client.logs.write(tag="agent", subtag="tool", data={"name": "shell"})
client.logs.write(tag="app", subtag="backend_started", data={"app_version": "1.2.0"})
```

- `tag: str` (required), `subtag: str | None = None`, `data: Any = None`
  (any JSON-serializable value — stored as opaque JSON server-side).

### Product events

```python
# App lifecycle
client.events.app_lifecycle.opened(os="darwin", os_version="25.3.0",
                                    app_version="1.2.0",
                                    timezone="America/Los_Angeles", locale="en-US")
client.events.app_lifecycle.closed()

# Agent sessions
client.events.agent.create(id="sess_123", name="Refactor auth", dashboard_id="dash_1")
client.events.agent.message(agent_id="sess_123", seq=0,
                            message=AgentMessage(id="m1", role="user", content="hello"))

# Dashboards
client.events.dashboard.event(dashboard_id="dash_1", action="create")  # open|close|create|delete

# Onboarding
client.events.onboarding.step(step_id="connect_provider", status="completed")  # started|completed|abandoned
```

`AgentMessage` is importable from the package:

```python
from swarm_analytics import AgentMessage
```

### Identity

```python
client.identify.link_email(email="user@example.com")
```

Links an email to the current install (resolved from the token). Use it once the
user provides an email; do **not** pass any id.

---

## 7. Categories and opt-out (`mode`)

Every endpoint has a category. `mode="minimal"` mutes only the `product`
category; everything else still flows:

| Category     | Endpoints                              | Flows in `minimal`? |
| ------------ | -------------------------------------- | ------------------- |
| `product`    | all `client.events.*`                  | **No** (muted)      |
| `diagnostic` | `client.logs.write`                    | **Yes**             |
| `identity`   | `client.identify.link_email`           | **Yes**             |
| `bootstrap`  | `register()`                           | **Yes**             |

So a **log write always flows**, even when the user opted out of product
telemetry. Map your app's existing opt-out toggle onto `mode`: opted-out →
`"minimal"`, otherwise `"full"`.

---

## 8. Durability (optional spool)

By default, in-flight records live in an in-memory queue and are lost if the
process dies with deliveries pending. Pass a spool to persist them to disk and
replay on next launch (with the same `submission_id`, so dedup still holds):

```python
from swarm_analytics import SqliteSpool

client = AnalyticsClient(base_url=..., token=...,
                         spool=SqliteSpool("/path/to/service_spool.db"))
```

For the initial integration you can skip this; add it once the basic path works.

---

## 9. Shutdown

Flush pending records before the process exits so you don't lose the tail:

```python
client.flush(timeout=2.0)   # block until drained, or give up after 2s
client.close()              # stop the worker thread
```

`AnalyticsClient` is also a context manager (`__exit__` flushes + closes).

---

## 10. Error model

| Where                      | What you get                                                        |
| -------------------------- | ------------------------------------------------------------------- |
| Bad call arguments         | `pydantic.ValidationError`, synchronously, on the calling thread.   |
| `register()` rejected/fail | `AuthError` (401) or `TransportError` (other / network).            |
| Delivery failures          | Handled internally (retry/drop). Never raised to the caller.        |

Importable errors:

```python
from swarm_analytics import AnalyticsError, AuthError, RateLimited, TransportError, ValidationRejected
```

---

## 11. Quick do / don't

**Do**
- Create exactly one `AnalyticsClient` per process and reuse it.
- Call `register()` once, persist the token, reuse it forever.
- Let the SDK fill `ts`/`submission_id`; let the server resolve identity.
- `flush()` + `close()` on shutdown.

**Don't**
- Don't pass `install_id`, `user_id`, `ts`, or `submission_id` — there's no
  parameter for them by design.
- Don't construct a new client per event.
- Don't call `register()` on every launch.
- Don't hand-edit anything under `_generated/` (it's regenerated from the service).
