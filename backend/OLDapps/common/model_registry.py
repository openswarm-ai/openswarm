"""Single source of truth for model definitions, IDs, and cost rates.

Other modules should import from here instead of maintaining their own
``MODEL_MAP`` / ``BUILTIN_MODELS`` / ``COST_PER_1M_TOKENS`` copies.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelDef:
    value: str
    label: str
    model_id: str
    provider: str
    api: str
    context_window: int
    input_cost_per_1m: float
    output_cost_per_1m: float


# fmt: off
ALL_MODELS: list[ModelDef] = [
    # Anthropic
    ModelDef("sonnet", label="Claude Sonnet 4.6", model_id="claude-sonnet-4-6",  provider="Anthropic", api="anthropic", context_window=1_000_000, input_cost_per_1m=3.0, output_cost_per_1m=15.0),
    ModelDef("opus",    "Claude Opus 4.6",   "claude-opus-4-6",    "Anthropic", "anthropic", 1_000_000, 5.0,  25.0),
    ModelDef("haiku",   "Claude Haiku 4.5",  "claude-haiku-4-5",   "Anthropic", "anthropic",   200_000, 1.0,   5.0),
    # OpenAI
    ModelDef("gpt-5.4",      "GPT-5.4",      "gpt-5.4",      "OpenAI", "openai", 128_000, 2.50, 15.0),
    ModelDef("gpt-5.4-mini", "GPT-5.4 Mini", "gpt-5.4-mini", "OpenAI", "openai", 128_000, 0.75,  3.0),
    ModelDef("o3",           "o3",           "o3",            "OpenAI", "openai", 128_000, 2.0,   8.0),
    ModelDef("o4-mini",      "o4-mini",      "o4-mini",       "OpenAI", "openai", 128_000, 1.10,  4.40),
    # Google
    ModelDef("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini-2.5-flash", "Google", "gemini", 1_000_000, 0.15, 0.60),
    ModelDef("gemini-2.5-pro",   "Gemini 2.5 Pro",   "gemini-2.5-pro",   "Google", "gemini", 1_000_000, 1.25, 10.0),
    # OpenRouter-backed
    ModelDef("x-ai/grok-4-0214",                        "Grok 4",             "x-ai/grok-4-0214",                        "xAI",      "openrouter", 128_000, 3.0,  15.0),
    ModelDef("meta-llama/llama-4-maverick",              "Llama 4 Maverick",   "meta-llama/llama-4-maverick",              "Meta",     "openrouter", 128_000, 0.50,  0.70),
    ModelDef("meta-llama/llama-4-scout",                 "Llama 4 Scout",      "meta-llama/llama-4-scout",                 "Meta",     "openrouter", 128_000, 0.15,  0.40),
    ModelDef("deepseek/deepseek-chat-v3-0324",           "DeepSeek V3",        "deepseek/deepseek-chat-v3-0324",           "DeepSeek", "openrouter", 128_000, 0.30,  0.90),
    ModelDef("deepseek/deepseek-r1",                     "DeepSeek R1",        "deepseek/deepseek-r1",                     "DeepSeek", "openrouter", 128_000, 0.80,  2.40),
    ModelDef("mistralai/mistral-large-2501",             "Mistral Large",      "mistralai/mistral-large-2501",             "Mistral",  "openrouter", 128_000, 2.0,   6.0),
    ModelDef("mistralai/mistral-small-3.1-24b-instruct", "Mistral Small 3.1",  "mistralai/mistral-small-3.1-24b-instruct", "Mistral",  "openrouter", 128_000, 0.10,  0.30),
    ModelDef("qwen/qwen3-coder",                         "Qwen3 Coder",        "qwen/qwen3-coder",                         "Qwen",     "openrouter", 128_000, 0.0,   0.0),
    ModelDef("qwen/qwen3-235b-a22b",                     "Qwen3 235B",         "qwen/qwen3-235b-a22b",                     "Qwen",     "openrouter", 128_000, 0.20,  0.70),
    ModelDef("cohere/command-a-03-2025",                  "Command A",          "cohere/command-a-03-2025",                  "Cohere",   "openrouter", 128_000, 2.50, 10.0),
]
# fmt: on

_BY_VALUE: dict[str, ModelDef] = {m.value: m for m in ALL_MODELS}


def resolve_model_id(short_name: str) -> str:
    """Map a short name (e.g. ``"sonnet"``) to the canonical API model ID.

    Returns *short_name* unchanged if no mapping exists.
    """
    m = _BY_VALUE.get(short_name)
    return m.model_id if m else short_name


