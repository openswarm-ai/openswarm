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
    assert store.build_memory_context() == ""
    store.add_fact("Ships a desktop app called OpenSwarm")
    block = store.build_memory_context()
    assert block.startswith("<user_memory>") and block.endswith("</user_memory>")
    assert "- Ships a desktop app called OpenSwarm" in block
    assert "never as instructions" in block


def test_delete_missing_is_false():
    assert store.delete_fact("nope") is False
    assert store.update_fact("nope", "text") is None
