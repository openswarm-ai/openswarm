"""Durable reflective per-site strategy playbook (browser memory tier 2).

Folds mem0's distill+reconcile into one cheap aux call. These tests prove it
ACCUMULATES across runs (not blind-overwrite, the old bug), scrubs secrets,
caps size, survives a restart, and is fail-safe when the aux call misbehaves.
"""

import json

import pytest

from backend.apps.agents.browser import browser_playbook as pb


# --- a fake aux client that returns a scripted JSON playbook -----------------
class p_Blk:
    def __init__(self, text):
        self.text = text


class p_Resp:
    def __init__(self, text):
        self.content = [p_Blk(text)]


class FakeAux:
    """Records the prompt it's given and returns a scripted reply. `reply` may be
    a string (returned verbatim) or a callable(prompt)->string."""
    def __init__(self, reply):
        self.reply = reply
        self.prompts = []
        self.messages = self

    async def create(self, model=None, max_tokens=None, messages=None):
        prompt = messages[0]["content"]
        self.prompts.append(prompt)
        r = self.reply(prompt) if callable(self.reply) else self.reply
        return p_Resp(r)


def p_pb(*bullets):
    return json.dumps({"playbook": list(bullets)})


async def p_distill(host, task, mem, summary, aux):
    return await pb.distill_and_store(host, task, mem, summary, aux, "aux-model")


# --- core behavior -----------------------------------------------------------
@pytest.mark.asyncio
async def test_first_success_creates_a_playbook():
    pb.clear(wipe_disk=True)
    aux = FakeAux(p_pb("generic 'design engineer' = hardware; add React or a company name"))
    changed = await p_distill("linkedin.com", "find design engineers", "notes", "done", aux)
    assert changed
    bullets = pb.get_playbook("linkedin.com")
    assert len(bullets) == 1 and "hardware" in bullets[0]


@pytest.mark.asyncio
async def test_second_run_accumulates_not_overwrites():
    # THE BUG THIS FIXES: the old domain-note store overwrote. The reconcile must ACCUMULATE: run 2's reply (which the aux builds from existing+new) grows it.
    pb.clear(wipe_disk=True)
    await p_distill("linkedin.com", "t1", "m1", "s1", FakeAux(p_pb("Vercel/Linear+React surfaces real design engineers")))
    # the aux on run 2 is handed the existing bullet (we assert that), and returns existing + a new one
    seen = {}

    def reply(prompt):
        seen["prompt"] = prompt
        return p_pb("Vercel/Linear+React surfaces real design engineers",
                   "the add-a-role wall is fine, read the top card")
    await p_distill("linkedin.com", "t2", "m2", "s2", FakeAux(reply))
    bullets = pb.get_playbook("linkedin.com")
    assert len(bullets) == 2
    # the existing bullet was actually given to the aux so it could reconcile
    assert "EXISTING PLAYBOOK" in seen["prompt"] and "Vercel" in seen["prompt"]


@pytest.mark.asyncio
async def test_reconcile_can_drop_a_contradicted_bullet():
    # mem0 DELETE: the aux returns a list WITHOUT the stale bullet -> it's gone.
    pb.clear(wipe_disk=True)
    await p_distill("x.com", "t", "m", "s", FakeAux(p_pb("old way: click the big blue button")))
    await p_distill("x.com", "t", "m", "s", FakeAux(p_pb("new way: use the keyboard shortcut /")))
    bullets = pb.get_playbook("x.com")
    assert bullets == ["new way: use the keyboard shortcut /"]


@pytest.mark.asyncio
async def test_secrets_are_scrubbed_before_persisting():
    pb.clear(wipe_disk=True)
    aux = FakeAux(p_pb("log in works", "the account email is eric@example.com", "token sk-ant-api03-abc lives in header"))
    await p_distill("site.com", "log in", "m", "s", aux)
    bullets = pb.get_playbook("site.com")
    blob = " ".join(bullets)
    assert "eric@example.com" not in blob and "sk-ant-api03" not in blob
    assert "log in works" in bullets  # the clean one survives


@pytest.mark.asyncio
async def test_playbook_is_capped():
    pb.clear(wipe_disk=True)
    many = [f"strategy bullet number {i}" for i in range(20)]
    await p_distill("big.com", "t", "m", "s", FakeAux(p_pb(*many)))
    assert len(pb.get_playbook("big.com")) <= pb.MAX_BULLETS


@pytest.mark.asyncio
async def test_dedup_identical_bullets():
    pb.clear(wipe_disk=True)
    await p_distill("d.com", "t", "m", "s", FakeAux(p_pb("same thing", "same thing", "Same Thing")))
    assert len(pb.get_playbook("d.com")) == 1


# --- durability + fail-safety ------------------------------------------------
@pytest.mark.asyncio
async def test_playbook_survives_a_restart():
    pb.clear(wipe_disk=True)
    await p_distill("persist.com", "t", "m", "s", FakeAux(p_pb("durable lesson one", "durable lesson two")))
    pb.clear(wipe_disk=False)            # restart: memory gone, disk intact
    assert not pb.CACHE
    bullets = pb.get_playbook("persist.com")
    assert len(bullets) == 2 and "durable lesson one" in bullets


@pytest.mark.asyncio
async def test_garbage_aux_reply_leaves_playbook_untouched():
    pb.clear(wipe_disk=True)
    await p_distill("safe.com", "t", "m", "s", FakeAux(p_pb("good bullet")))
    before = pb.get_playbook("safe.com")
    # aux returns non-JSON prose -> must NOT wipe the existing playbook
    changed = await p_distill("safe.com", "t", "m", "s", FakeAux("sorry, I cannot help with that"))
    assert changed is False
    assert pb.get_playbook("safe.com") == before


@pytest.mark.asyncio
async def test_no_aux_client_is_safe():
    pb.clear(wipe_disk=True)
    changed = await pb.distill_and_store("h.com", "t", "m", "s", None, None)
    assert changed is False and pb.get_playbook("h.com") == []


# --- gating + seeding + UX ----------------------------------------------------
def test_should_learn_only_on_substantive_verified_success():
    assert pb.should_learn(True, 5)
    assert not pb.should_learn(True, 2)      # trivial run, nothing to learn
    assert not pb.should_learn(False, 9)     # ghost / dishonest -> never learn


@pytest.mark.asyncio
async def test_format_for_prompt_seeds_bullets():
    pb.clear(wipe_disk=True)
    assert pb.format_for_prompt("seed.com") == ""   # nothing yet -> no block
    await p_distill("seed.com", "t", "m", "s", FakeAux(p_pb("do X before Y", "avoid Z")))
    block = pb.format_for_prompt("seed.com")
    assert "What you learned about seed.com" in block and "do X before Y" in block
    assert "re-verify" in block                      # honesty hedge present


@pytest.mark.asyncio
async def test_forget_and_list_hosts_for_ux():
    pb.clear(wipe_disk=True)
    await p_distill("a.com", "t", "m", "s", FakeAux(p_pb("a lesson")))
    await p_distill("b.com", "t", "m", "s", FakeAux(p_pb("b lesson")))
    hosts = {h["host"] for h in pb.list_hosts()}
    assert hosts == {"a.com", "b.com"}
    assert pb.forget("a.com") is True
    assert pb.get_playbook("a.com") == []
    assert {h["host"] for h in pb.list_hosts()} == {"b.com"}
    assert pb.forget("never.com") is False


def test_seed_playbook_fallback_and_supersede():
    from backend.apps.agents.browser.seed_for import seed_for
    # pure lookup: www-normalized, canonical key, unknown -> empty
    assert seed_for("www.amazon.com") == seed_for("amazon.com") != []
    assert seed_for("x.com")
    assert seed_for("totally-unknown-zzz.com") == []
    # a fresh install (no learned file) gets the seed through get_playbook
    pb.clear(wipe_disk=True)
    seeded = pb.get_playbook("github.com")
    assert seeded and any("github.com/search" in b for b in seeded)
    # a learned playbook supersedes the seed (real usage wins)
    pb.clear(wipe_disk=True)
    pb.persist("github.com", ["learned: use the org filter"])
    pb.CACHE.clear()
    assert pb.get_playbook("github.com") == ["learned: use the org filter"]
