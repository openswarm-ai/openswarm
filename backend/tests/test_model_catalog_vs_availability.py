"""A model's ABSENCE from today's picker is not evidence it was retired.

The bug class (ENG-386, seen live on a field install): /models is intersected with available creds
and with 9Router's in-process provider state, so a router bounce or a provider cooldown drops whole
vendors out of the payload. The renderer read "not in the list" as "retired", rewrote every session
pinned to that vendor onto the default model, and PERSISTED it. A chat the user had put on GPT came
back on Claude, and then collected Anthropic policy blocks the user could not explain.

The seal: the payload carries a catalog that depends on neither creds nor router state. Availability
answers "can you use this right now"; only the catalog answers "does this still exist", and only the
catalog may retire a session's model.
"""

import asyncio
from unittest.mock import patch

from backend.apps.agents.agents import list_models
from backend.apps.settings.models import AppSettings, CustomProvider


def p_run(cfg: AppSettings, *, router_up: bool = False):
    with patch("backend.apps.settings.settings.load_settings", return_value=cfg), \
         patch("backend.apps.nine_router.is_running", return_value=router_up):
        return asyncio.run(list_models())


def test_a_provider_dropout_does_not_empty_the_catalog():
    """The whole point: with nothing connected, availability collapses but the catalog does not."""
    result = p_run(AppSettings())
    available = {m["value"] for rows in result["models"].values() for m in rows}
    known = set(result["known_values"])

    assert known, "the catalog must never be empty, or the renderer has no way to tell gone from unreachable"
    assert known - available, "a dropout must leave models known-but-unavailable, which is exactly the state that used to read as retired"


def test_subscription_models_survive_a_router_bounce_in_the_catalog():
    """9Router stamps provider state in-process, so a bounce un-connects every subscription lane."""
    up = p_run(AppSettings(), router_up=True)
    down = p_run(AppSettings(), router_up=False)
    assert set(down["known_values"]) == set(up["known_values"]), "the catalog must not move when the router does"


def test_a_custom_providers_models_are_in_the_catalog():
    cfg = AppSettings(custom_providers=[
        CustomProvider(name="Ollama Cloud", base_url="https://ollama.com/v1", api_key="x",
                       models=[{"value": "gpt-oss:120b", "label": "gpt-oss:120b"}]),
    ])
    assert "custom/ollama-cloud/gpt-oss:120b" in p_run(cfg)["known_values"]


def test_an_unenumerable_provider_marks_the_catalog_incomplete():
    """A key we could not enumerate means we cannot vouch for the list, so nothing may be retired from it."""
    cfg = AppSettings(openrouter_api_key="sk-or-broken")
    with patch("backend.apps.agents.providers.registry.fetch_openrouter_models",
               side_effect=RuntimeError("network down")):
        result = p_run(cfg)
    assert result["catalog_complete"] is False

    assert p_run(AppSettings())["catalog_complete"] is True
