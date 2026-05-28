"""Model tier scoring + billing-kind classification for the picker hover card."""

from __future__ import annotations


# ---------------------------------------------------------------------------
# Curated model tiers; Intelligence, Speed, Cost on a 1-5 scale
# ---------------------------------------------------------------------------
#
# Hand-tuned from public benchmarks + per-token pricing (knowledge cutoff
# Jan 2026). The tier numbers serve the picker hover card so users can
# pick a model that fits the task without reading a leaderboard.
#
#   Intelligence:  5 = frontier reasoner, 1 = nano / specialised tiny
#   Speed:         5 = sub-second TTFT + 250 tok/s, 1 = slow + thinking
#   Cost:          5 = $25+/M output, 1 = under $0.50/M output (or free)
#
# Lookup order (compute_tiers below):
#   1. Bare model_id direct
#   2. ":free" stripped (so anthropic/claude-opus-4.7:free shares scoring
#      with anthropic/claude-opus-4.7)
#   3. Vendor-prefixed and bare-after-slash variants for cross-format
#      coverage (so "claude-opus-4-7" matches "anthropic/claude-opus-4.7")
#   4. Last-path-component normalised (dashes ↔ dots)
#
# Models not in this map fall through to a heuristic that uses cost
# bucket + reasoning flag + name-keyword adjustments.
# (intelligence, speed, cost) on a 1-5 scale. Tiers: 5 frontier, 4 top
# open / strong sub, 3 solid mid, 2 small specialised, 1 nano.
MODEL_TIERS: dict[str, tuple[int, int, int]] = {
    # Anthropic
    "claude-opus-4-7":              (5, 2, 5),
    "claude-opus-4.7":              (5, 2, 5),
    "anthropic/claude-opus-4.7":    (5, 2, 5),
    "claude-opus-4-6":              (5, 2, 5),
    "claude-opus-4.6":              (5, 2, 5),
    "anthropic/claude-opus-4.6":    (5, 2, 5),
    "claude-opus-4-5":              (5, 2, 5),
    "claude-opus-4":                (5, 2, 5),
    "anthropic/claude-opus-4":      (5, 2, 5),
    "claude-sonnet-4-6":            (4, 4, 3),
    "claude-sonnet-4.6":            (4, 4, 3),
    "anthropic/claude-sonnet-4.6":  (4, 4, 3),
    "claude-sonnet-4-5":            (4, 4, 3),
    "claude-sonnet-4.5":            (4, 4, 3),
    "anthropic/claude-sonnet-4.5":  (4, 4, 3),
    "claude-sonnet-4":              (4, 4, 3),
    "anthropic/claude-sonnet-4":    (4, 4, 3),
    "claude-3.7-sonnet":            (4, 4, 3),
    "anthropic/claude-3.7-sonnet":  (4, 4, 3),
    "claude-haiku-4-5":             (3, 5, 2),
    "claude-haiku-4.5":             (3, 5, 2),
    "anthropic/claude-haiku-4.5":   (3, 5, 2),
    "claude-3.5-haiku":             (2, 5, 2),
    "anthropic/claude-3.5-haiku":   (2, 5, 2),
    "claude-3-haiku":               (2, 5, 1),
    "anthropic/claude-3-haiku":     (2, 5, 1),

    # OpenAI
    "gpt-5.5":                  (5, 2, 5),
    "openai/gpt-5.5":           (5, 2, 5),
    "gpt-5.5-pro":              (5, 1, 5),
    "openai/gpt-5.5-pro":       (5, 1, 5),
    "gpt-5.4":                  (4, 3, 4),
    "openai/gpt-5.4":           (4, 3, 4),
    "gpt-5.4-mini":             (3, 4, 2),
    "openai/gpt-5.4-mini":      (3, 4, 2),
    "gpt-5.3-codex":            (4, 3, 3),
    "gpt-5.3-codex-high":       (5, 2, 4),
    "gpt-5.3-codex-xhigh":      (5, 1, 4),
    "gpt-5":                    (4, 3, 4),
    "openai/gpt-5":             (4, 3, 4),
    "gpt-5-mini":               (3, 4, 2),
    "openai/gpt-5-mini":        (3, 4, 2),
    "gpt-5-nano":               (2, 5, 1),
    "openai/gpt-5-nano":        (2, 5, 1),
    "gpt-chat-latest":          (3, 4, 2),
    "openai/gpt-chat-latest":   (3, 4, 2),
    "gpt-oss-120b":             (3, 3, 1),
    "openai/gpt-oss-120b":      (3, 3, 1),
    "gpt-oss-20b":              (2, 4, 1),
    "openai/gpt-oss-20b":       (2, 4, 1),

    # Google
    "gemini-3.1-pro-preview":           (5, 3, 4),
    "gemini-3.1-pro":                   (5, 3, 4),
    "google/gemini-3.1-pro":            (5, 3, 4),
    "gemini-3.1-flash-lite-preview":    (2, 5, 1),
    "gemini-3.1-flash-lite":            (2, 5, 1),
    "google/gemini-3.1-flash-lite":     (2, 5, 1),
    "gemini-3-pro-preview":             (5, 3, 4),
    "gemini-3-pro":                     (5, 3, 4),
    "google/gemini-3-pro":              (5, 3, 4),
    "gemini-3-flash-preview":           (3, 5, 2),
    "gemini-3-flash":                   (3, 5, 2),
    "google/gemini-3-flash":            (3, 5, 2),
    "gemini-2.5-pro":                   (4, 3, 3),
    "google/gemini-2.5-pro":            (4, 3, 3),
    "gemini-2.5-flash":                 (3, 5, 1),
    "google/gemini-2.5-flash":          (3, 5, 1),

    # xAI
    "x-ai/grok-4":          (5, 3, 4),
    "x-ai/grok-4-0214":     (5, 3, 4),
    "x-ai/grok-4.3":        (5, 3, 4),
    "x-ai/grok-4-heavy":    (5, 2, 5),
    "x-ai/grok-3":          (4, 4, 3),
    "x-ai/grok-3-mini":     (2, 5, 1),
    "x-ai/grok-code-fast":  (3, 5, 2),

    # DeepSeek
    "deepseek/deepseek-r1":             (5, 2, 2),  # cheap-but-frontier reasoner
    "deepseek/deepseek-r1-0528":        (5, 2, 2),
    "deepseek/deepseek-chat":           (4, 4, 2),
    "deepseek/deepseek-v3":             (4, 4, 2),
    "deepseek/deepseek-v3.1":           (4, 4, 2),
    "deepseek/deepseek-v3.1-base":      (4, 4, 2),
    "deepseek/deepseek-v3.1-terminus":  (4, 4, 2),
    "deepseek/deepseek-chat-v3-0324":   (4, 4, 2),
    "deepseek/deepseek-v3.2":           (3, 4, 1),
    "deepseek/deepseek-v3.2-exp":       (3, 4, 1),

    # Meta Llama
    "meta-llama/llama-4-maverick":          (4, 4, 2),
    "meta-llama/llama-4-scout":             (3, 4, 1),
    "meta-llama/llama-3.3-70b":             (3, 4, 1),
    "meta-llama/llama-3.3-70b-instruct":    (3, 4, 1),
    "meta-llama/llama-3.3-8b":              (2, 5, 1),
    "meta-llama/llama-3.2-3b":              (1, 5, 1),
    "meta-llama/llama-3.2-1b":              (1, 5, 1),
    "meta-llama/llama-3.1-8b":              (2, 5, 1),

    # Qwen
    "qwen/qwen3-coder":             (4, 3, 2),
    "qwen/qwen3-235b-a22b":         (4, 3, 2),
    "qwen/qwen3-72b":               (3, 4, 1),
    "qwen/qwen3-32b":               (2, 4, 1),
    "qwen/qwen3-14b":               (2, 5, 1),
    "qwen/qwen3-vl-235b-thinking":  (4, 2, 3),
    "qwen/qwen3-vl-8b-thinking":    (2, 3, 1),
    "qwen/qwen3-next-80b-a3b-instruct": (3, 4, 1),

    # Mistral
    "mistralai/mistral-large-2501":             (4, 4, 3),
    "mistralai/mistral-large":                  (4, 4, 3),
    "mistralai/mistral-medium-3-5":             (3, 4, 2),
    "mistralai/mistral-medium-3":               (3, 4, 2),
    "mistralai/mistral-small-3.1-24b-instruct": (2, 5, 1),
    "mistralai/codestral":                      (3, 5, 2),
    "mistralai/ministral-8b":                   (1, 5, 1),
    "mistralai/ministral-3b":                   (1, 5, 1),

    # Cohere
    "cohere/command-a-03-2025":     (3, 4, 3),
    "cohere/command-r-plus":        (3, 4, 2),
    "cohere/command-r":             (2, 5, 1),

    # Misc frontier-ish
    "moonshotai/kimi-k2":           (4, 3, 2),
    "moonshotai/kimi-k1.5":         (4, 3, 2),
    "z-ai/glm-4.6":                 (4, 3, 2),
    "z-ai/glm-4.5":                 (4, 3, 2),
    "z-ai/glm-4.5-air":             (3, 4, 1),
    "ai21/jamba-large-1.7":         (3, 4, 2),
    "minimax/minimax-m2":           (4, 3, 2),
    "minimax/minimax-m1":           (4, 3, 2),
    "bytedance-seed/seed-1.6":      (4, 4, 2),
    "bytedance-seed/seed-1.6-flash": (3, 5, 1),

    # Smaller/specialised
    "baidu/cobuddy":                (2, 4, 1),
    "baidu/ernie-4.5-21b-a3b":      (2, 5, 1),
    "nvidia/nemotron-3-nano-30b-a3b":           (2, 5, 1),
    "nvidia/nemotron-3-super-120b-a12b":        (3, 3, 2),
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": (2, 4, 1),
    "ibm-granite/granite-4.1-8b":   (1, 5, 1),
    "ibm-granite/granite-3-8b":     (1, 5, 1),
    "inception/mercury-coder":      (2, 5, 1),
    "thedrummer/cydonia":           (1, 5, 1),
    "sao10k/l3.3-euryale-70b":      (2, 4, 1),
}


def _heuristic_tiers(label: str, output_cost_per_1m: float, reasoning: bool) -> tuple[int, int, int]:
    """Fallback tier scoring for models not in MODEL_TIERS. Tries to
    extract a parameter count from the label (8B/70B/235B/etc.) and
    use that as a stronger size signal than cost alone, since open-
    source vendors price aggressively low for marketing reasons.

    Distribution:
      Intelligence:
        - 200B+ params or $25+/M  → 5
        - 70-200B or $5-$25/M     → 4
        - 30-70B or $1-$5/M       → 3
        - 8-30B or $0.20-$1/M     → 2
        - <8B or <$0.20/M         → 1
        + reasoning bumps tier 1-3 by 1; doesn't push 4→5 unless
          the model is genuinely huge.
      Speed:
        - inverse of size, with name keywords as ±1 nudges.
      Cost: pure cost bucket.
    """
    import re as _re
    out = output_cost_per_1m or 0.0

    # Cost bucket; same 5-tier cost ladder as before.
    if out < 0.5:
        cb = 1
    elif out < 2:
        cb = 2
    elif out < 7:
        cb = 3
    elif out < 25:
        cb = 4
    else:
        cb = 5

    # Try to parse a parameter count. Label often carries something
    # like "Llama 3.3 70B" or "Qwen3 235B". 235B → 5, 70B → 4, 30B
    # → 3, 14B → 2, 7B → 1. We only trust the param count when it's
    # clearly above 1B (so we don't pick up version numbers).
    lower = (label or "").lower()
    param_b = 0.0
    for m in _re.finditer(r"\b(\d{1,4}(?:\.\d+)?)\s*b\b", lower):
        try:
            v = float(m.group(1))
            if v >= 1 and v > param_b:
                param_b = v
        except ValueError:
            pass

    if param_b >= 200:
        size_tier = 5
    elif param_b >= 70:
        size_tier = 4
    elif param_b >= 30:
        size_tier = 3
    elif param_b >= 8:
        size_tier = 2
    elif param_b > 0:
        size_tier = 1
    else:
        size_tier = 0  # unknown; fall back to cost

    # Intelligence is the max of cost bucket and parsed size tier.
    # Cost is high-confidence for closed-source frontier; size is
    # high-confidence for open-source ladders. Whichever is higher
    # is closer to the truth.
    intel = max(cb, size_tier)
    if reasoning and intel < 4:
        # Reasoning is a strong intelligence signal but only for
        # genuinely smaller models; frontier closed-source already
        # caps at 5, so don't double-count there.
        intel += 1

    # Speed inverse of intel.
    speed = 6 - intel
    if _re.search(r"\b(mini|lite|flash|haiku|nano|small|fast|turbo|micro|tiny)\b", lower):
        speed += 1
    if _re.search(r"\b(opus|ultra|max|xlarge|titan|huge)\b", lower):
        speed -= 1
    if reasoning and intel >= 4:
        # Frontier reasoning models burn lots of tokens on hidden
        # thoughts; user-perceived speed drops.
        speed -= 1

    return (
        max(1, min(5, intel)),
        max(1, min(5, speed)),
        max(1, min(5, cb)),
    )


def compute_tiers(
    model_id: str,
    label: str,
    output_cost_per_1m: float,
    reasoning: bool,
) -> tuple[int, int, int]:
    """Look up a (intelligence, speed, cost) triple. Curated map first;
    heuristic fallback for the long tail."""
    candidates = [model_id]
    if ":free" in model_id:
        candidates.append(model_id.replace(":free", ""))
    if "/" in model_id:
        tail = model_id.split("/", 1)[1]
        candidates.append(tail)
        if ":free" in tail:
            candidates.append(tail.replace(":free", ""))
    # Try dashes-vs-dots normalisations for each candidate.
    for c in list(candidates):
        if "." in c:
            candidates.append(c.replace(".", "-"))
        if "-" in c:
            candidates.append(c.replace("-", "."))

    # Dedup while preserving order.
    seen = set()
    ordered = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)

    for c in ordered:
        if c in MODEL_TIERS:
            return MODEL_TIERS[c]

    return _heuristic_tiers(label, output_cost_per_1m, reasoning)


def compute_billing_kind(
    *,
    api: str,
    route: str | None,
    is_or_free: bool,
    settings,
) -> str:
    """Return one of:
        'subscription'; covered by an OAuth sub or Pro plan; hide cost row
        'api_key'     ; direct API-key path (Anthropic / OpenAI / Gemini)
        'free'        ; genuinely $0 per token (rate-limited OR :free tier)
        'paid'        ; per-token metering through OpenRouter; show pricing

    Why 'api_key' is split from 'paid': both meter per-token, but the user
    is paying a different counterparty. Letting the picker filter chips
    "API key" vs "Subscription" gives users a clear way to scope to their
    billing relationship; direct API key vs OAuth subscription; instead
    of conflating them under a generic "paid" bucket.

    Subscription paths:
      - api=codex (Codex sub via 9Router)
      - api=gemini-cli (Gemini CLI sub via 9Router)
      - route="cc" (Claude sub via 9Router)
      - api=anthropic, adaptive route, Pro mode active with bearer
    """
    if api == "codex":
        return "subscription"
    if api == "gemini-cli":
        return "subscription"
    if route == "cc":
        return "subscription"
    if (
        api == "anthropic"
        and route is None
        and getattr(settings, "connection_mode", "own_key") == "openswarm-pro"
        and getattr(settings, "openswarm_bearer_token", None)
    ):
        return "subscription"
    if route == "api":
        return "api_key"
    if is_or_free:
        return "free"
    return "paid"
