"""GPT-6 Astra (2026-09-03): both lanes in the catalog, priced, tiered, and the passthrough rules extended to its prefix."""
from backend.apps.agents.providers.registry import find_builtin_model, BUILTIN_MODELS as PROVIDER_MODELS


def test_gpt6_astra_is_on_both_lanes_with_the_documented_ids():
    sub = find_builtin_model("gpt-6")
    assert sub and sub["router_model_id"] == "cx/gpt-6-astra" and sub["api"] == "codex" and sub["subscription_only"] is True
    api = find_builtin_model("gpt-6-api")
    assert api and api["router_model_id"] == "cp-openai/gpt-6-astra" and api["model_id"] == "gpt-6-astra" and api["route"] == "api"
    assert sub["context_window"] == api["context_window"] == 1_050_000


def test_gpt6_astra_prices_and_tier():
    from backend.apps.agents.providers.registry import COST_PER_1M_TOKENS as MODEL_PRICING
    assert MODEL_PRICING[("OpenAI", "gpt-6-api")] == (10.0, 50.0), "the short-context API rate"
    assert MODEL_PRICING[("OpenAI", "gpt-6")] == (0.0, 0.0), "the subscription lane bills nothing per token"
    from backend.apps.agents.providers.pricing import MODEL_TIERS
    assert MODEL_TIERS["gpt-6-astra"] == (5, 2, 5)
    from backend.apps.agents.providers.openrouter import P_DIRECT_API_PRICING
    assert P_DIRECT_API_PRICING["gpt-6-astra"] == (10.00, 50.00)


def test_gpt6_sits_beside_the_gpt5_family_in_the_openai_list():
    values = [m["value"] for m in PROVIDER_MODELS["OpenAI"]]
    assert values.index("gpt-6") < values.index("gpt-5.6") and values.index("gpt-6-api") < values.index("gpt-5.6-api")
