"""The browser-memory UX surface: list + forget endpoints.

Calls the real route handlers directly (thin wrappers over the already-tested
skill + playbook stores) so the user-facing 'see what it learned / forget it'
controls are proven, including that forget actually clears both tiers.
"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from backend.apps.agents import agents as agents_mod
from backend.apps.agents.browser import browser_playbook as pb
from backend.apps.agents.browser import browser_skills as sk


def seed_skill(host, task):
    sk.record_skill(host, task, [
        {"tool": "BrowserClickIndex", "input": {}, "ok": True,
         "clicked_role": "button", "clicked_name": "Go"},
    ])


async def seed_strategy(host, *bullets):
    resp = SimpleNamespace(
        content=[SimpleNamespace(text=json.dumps({"playbook": list(bullets)}))]
    )
    aux = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(return_value=resp)))
    await pb.distill_and_store(host, "t", "m", "s", aux, "aux")


def test_list_browser_memory_groups_skills_and_strategy_by_site():
    sk.clear(); pb.clear(wipe_disk=True)
    seed_skill("shop.com", "search now")
    asyncio.run(seed_strategy("shop.com", "use the search box at the top"))
    asyncio.run(seed_strategy("docs.com", "share lives behind the blue button"))

    out = asyncio.run(agents_mod.list_browser_memory())
    sites = {s["host"]: s for s in out["sites"]}
    assert set(sites) == {"shop.com", "docs.com"}
    assert sites["shop.com"]["strategy"] == ["use the search box at the top"]
    assert len(sites["shop.com"]["skills"]) == 1
    assert sites["docs.com"]["strategy"] == ["share lives behind the blue button"]


def test_forget_clears_both_tiers_for_a_site():
    sk.clear(); pb.clear(wipe_disk=True)
    seed_skill("gone.com", "do it now")
    asyncio.run(seed_strategy("gone.com", "a strategy bullet"))
    # sanity: present
    assert pb.get_playbook("gone.com") and sk.list_skills("gone.com")

    res = asyncio.run(agents_mod.forget_browser_memory("gone.com"))
    assert res["ok"] and res["forgot_strategy"] is True and res["forgot_skills"] >= 1
    # both tiers actually cleared
    assert pb.get_playbook("gone.com") == []
    assert sk.list_skills("gone.com") == []
    # the site no longer appears in the listing
    out = asyncio.run(agents_mod.list_browser_memory())
    assert "gone.com" not in {s["host"] for s in out["sites"]}


def test_forget_unknown_site_is_harmless():
    sk.clear(); pb.clear(wipe_disk=True)
    res = asyncio.run(agents_mod.forget_browser_memory("never.com"))
    assert res["ok"] and res["forgot_strategy"] is False and res["forgot_skills"] == 0
