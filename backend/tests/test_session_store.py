import asyncio

from backend.apps.agents import agent_manager as am
from backend.apps.agents.manager import view_builder_state as vbs
from backend.apps.agents.manager.session.SessionStore import SessionStore
import backend.apps.agents.manager.session.SessionLifecycle as lifecycle_mod


def p_seed_store(store: SessionStore, dead_id: str = "dead", alive_id: str = "alive") -> None:
    store.sessions = {dead_id: object(), alive_id: object()}
    store.tasks = {dead_id: object(), alive_id: object()}
    store.live_partial = {dead_id: object(), alive_id: object()}
    store.cancel_events = {dead_id: asyncio.Event(), alive_id: asyncio.Event()}
    store.client_pool = {dead_id: object(), alive_id: object()}
    store.hook_ctxs = {dead_id: object(), alive_id: object()}
    store.stderr_buffers = {dead_id: ["stderr"], alive_id: ["stderr"]}


def p_assert_only_alive_remains(store: SessionStore, dead_id: str = "dead", alive_id: str = "alive") -> None:
    for mapping in [
        store.sessions,
        store.tasks,
        store.live_partial,
        store.cancel_events,
        store.client_pool,
        store.hook_ctxs,
        store.stderr_buffers,
    ]:
        assert dead_id not in mapping
        assert alive_id in mapping


def test_manager_runtime_maps_are_live_store_aliases():
    store = SessionStore()
    mgr = am.AgentManager(store=store)

    sessions = {"s1": object()}
    mgr.sessions = sessions
    assert mgr.store.sessions is sessions
    assert store.sessions is sessions

    store.tasks["s1"] = object()
    assert mgr.tasks is store.tasks


def test_session_store_purge_removes_target_from_all_runtime_maps():
    store = SessionStore()
    p_seed_store(store)

    store.purge_session_runtime("dead")

    p_assert_only_alive_remains(store)


def test_session_store_helpers_cover_current_runtime_contract():
    store = SessionStore()
    session = object()
    task = object()
    event = asyncio.Event()

    store.set_session("s1", session)
    store.set_task("s1", task)
    store.set_live_partial("s1", {"text": "partial"})
    store.set_cancel_event("s1", event)
    store.set_hook_ctx("s1", {"ctx": True})

    assert store.get_session("s1") is session
    assert store.has_session("s1")
    assert store.session_items() == [("s1", session)]
    assert store.session_values() == [session]
    assert store.get_task("s1") is task
    assert store.is_live_task("s1", task)
    assert store.pop_live_partial("s1") == {"text": "partial"}
    assert store.get_cancel_event("s1") is event
    assert store.get_hook_ctx("s1") == {"ctx": True}
    assert store.get_or_create_stderr_buffer("s1") == []
    assert store.pop_task("s1") is task
    assert store.pop_session("s1") is session


def test_purge_session_memory_routes_runtime_maps_through_store_and_keeps_side_effects(monkeypatch):
    store = SessionStore()
    p_seed_store(store)
    mgr = am.AgentManager(store=store)
    disposed: list[tuple[object, str]] = []

    def p_dispose_client_soon(pool, session_id):
        disposed.append((pool, session_id))
        pool.pop(session_id, None)

    monkeypatch.setattr(lifecycle_mod, "dispose_client_soon", p_dispose_client_soon)
    vbs.view_builder_render_retry_counts["dead"] = 4
    vbs.view_builder_dirty_sessions.add("dead")

    mgr.purge_session_memory("dead")

    p_assert_only_alive_remains(store)
    assert disposed == [(store.client_pool, "dead")]
    assert "dead" not in vbs.view_builder_render_retry_counts
    assert "dead" not in vbs.view_builder_dirty_sessions
