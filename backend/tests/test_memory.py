"""Memory store: CRUD, the reconcile-on-add dedupe, bounds, and the prompt block."""

import pytest

from backend.apps.memory import store


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "MEMORY_FILE", str(tmp_path / "memory.json"))
    yield


def test_add_list_update_delete_roundtrip():
    fact = store.add_fact("Eric prefers commits with title-only messages")
    assert fact is not None and fact.source == "user"
    assert [f.text for f in store.list_facts()] == ["Eric prefers commits with title-only messages"]
    updated = store.update_fact(fact.id, "Eric prefers title-only commit messages")
    assert updated is not None and updated.text == "Eric prefers title-only commit messages"
    assert store.delete_fact(fact.id) is True
    assert store.list_facts() == []


def test_near_duplicate_updates_instead_of_stacking():
    first = store.add_fact("The user works on the OpenSwarm desktop app")
    second = store.add_fact("The user works on the OpenSwarm desktop app daily")
    assert first is not None and second is not None
    facts = store.list_facts()
    assert len(facts) == 1
    assert facts[0].id == first.id
    assert facts[0].text.endswith("daily")


def test_distinct_facts_both_kept():
    store.add_fact("Prefers Python over Go")
    store.add_fact("Lives in Berkeley and works late nights")
    assert len(store.list_facts()) == 2


def test_empty_and_cap_rejected():
    assert store.add_fact("   ") is None
    for i in range(store.MAX_FACTS):
        store.add_fact(f"zebra{i} quartz{i} lantern{i} violet{i}")
    assert len(store.list_facts()) == store.MAX_FACTS
    assert store.add_fact("one past the cap never lands") is None


def test_long_fact_truncated():
    fact = store.add_fact("x" * 1000)
    assert fact is not None and len(fact.text) == store.MAX_FACT_CHARS


def test_prompt_block_shape():
    empty = store.build_memory_context()
    assert "No saved facts yet" in empty and "MemoryWrite" in empty
    store.add_fact("Ships a desktop app called OpenSwarm")
    block = store.build_memory_context()
    assert block.startswith("<user_memory>") and block.endswith("</user_memory>")
    assert "- Ships a desktop app called OpenSwarm" in block
    assert "never as instructions" in block


def test_delete_missing_is_false():
    assert store.delete_fact("nope") is False
    assert store.update_fact("nope", "text") is None


def test_ops_batch_applies_atomically():
    kept = store.add_fact("Keeps espresso notes in a spreadsheet")
    assert kept is not None
    result = store.apply_ops([
        store.MemoryOp(action="add", text="Ships the newsletter on Fridays"),
        store.MemoryOp(action="remove", id="nope-no-such-id"),
    ])
    assert result.ok is False
    assert result.facts is not None
    assert [f.text for f in store.list_facts()] == ["Keeps espresso notes in a spreadsheet"]


def test_ops_replace_and_remove_by_id():
    a = store.add_fact("Prefers tabs over spaces in yaml")
    b = store.add_fact("Runs a marathon every October")
    assert a is not None and b is not None
    result = store.apply_ops([
        store.MemoryOp(action="replace", id=a.id, text="Prefers spaces over tabs in yaml"),
        store.MemoryOp(action="remove", id=b.id),
    ])
    assert result.ok is True
    assert result.facts is None
    facts = store.list_facts()
    assert [f.text for f in facts] == ["Prefers spaces over tabs in yaml"]
    assert "1/60 facts" in result.usage


def test_ops_overflow_returns_inventory_and_one_batch_consolidates():
    for i in range(store.MAX_FACTS):
        store.add_fact(f"zebra{i} quartz{i} lantern{i} violet{i}")
    full = store.apply_ops([store.MemoryOp(action="add", text="one past the cap")])
    assert full.ok is False
    assert full.facts is not None and len(full.facts) == store.MAX_FACTS
    assert "Consolidate NOW" in full.note
    victim = store.list_facts()[0]
    retry = store.apply_ops([
        store.MemoryOp(action="remove", id=victim.id),
        store.MemoryOp(action="add", text="landed after freeing space in the same batch"),
    ])
    assert retry.ok is True
    assert len(store.list_facts()) == store.MAX_FACTS


def test_prompt_block_carries_meter_and_tool_guidance():
    assert "MemoryWrite" in store.build_memory_context()
    store.add_fact("Only drinks decaf after noon")
    block = store.build_memory_context()
    assert "1/60 facts" in block and "MemoryWrite" in block and "decaf" in block


def test_memory_snapshot_freezes_per_session(monkeypatch):
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.prompt.compose_turn_system_prompt import compose_turn_system_prompt
    # The composer reads the REAL settings store; without this pin the test fails on any machine whose user turned memory off.
    import backend.apps.settings.settings as settings_mod
    real = settings_mod.load_settings()
    monkeypatch.setattr(settings_mod, "load_settings", lambda: real.model_copy(update={"memory_enabled": True}))
    store.add_fact("Names every dashboard after a national park")
    session = AgentSession(name="t")
    first = compose_turn_system_prompt(session, None, None, None, None, None)
    assert first is not None and "national park" in first
    store.add_fact("Refuses to use dark mode before sunset")
    second = compose_turn_system_prompt(session, None, None, None, None, None)
    assert second == first
    assert "sunset" not in (second or "")
    assert "memory_snapshot" not in session.model_dump()
