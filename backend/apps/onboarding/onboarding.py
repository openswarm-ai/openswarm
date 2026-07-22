"""Onboarding v3 sub-app: identity summary, consented local scan, starter prep.

Mounted at /api/onboarding. All three endpoints are read-only with respect to
the user's machine and providers; nothing here mutates state or leaves the box
except the prep call, which goes to the user's own configured model.
"""

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Awaitable

from typeguard import typechecked

# Hard cap on any single provider harvest so a wedged endpoint can't hold the whole reveal hostage
# (the raw-httpx paths already carry a 20s per-request timeout; this bounds the multi-request loop).
P_HARVEST_BUDGET_S = 26.0


async def p_budgeted(coro: Awaitable[str]) -> str:
    """Await a harvest under the budget; any failure (timeout, provider down) fails open to ''."""
    try:
        return await asyncio.wait_for(coro, timeout=P_HARVEST_BUDGET_S)
    except Exception:
        return ""

from backend.apps.onboarding.identity import build_identity
from backend.apps.onboarding.local_scan import run_local_scan
from backend.apps.onboarding.models import PrepRequest
from backend.apps.onboarding.prep import build_prep
from backend.config.Apps import SubApp


@asynccontextmanager
async def onboarding_lifespan():
    yield


onboarding = SubApp("onboarding", onboarding_lifespan)


@onboarding.router.get("/identity")
@typechecked
async def get_identity() -> dict:
    # Disk rows, not the router's HTTP /providers: only db.json carries idToken/email, and it stays readable while the router is down.
    from backend.apps.nine_router.process import read_persisted_connections

    return build_identity(read_persisted_connections()).model_dump()


@onboarding.router.post("/scan")
@typechecked
def post_scan() -> dict:
    return run_local_scan(Path.home()).model_dump()


@onboarding.router.post("/prep")
@typechecked
async def post_prep(body: PrepRequest) -> dict:
    from backend.apps.onboarding.usage.chatgpt_usage import harvest_chatgpt_usage
    from backend.apps.onboarding.usage.claude_usage import harvest_claude_usage
    from backend.apps.settings.store import load_settings

    # ALWAYS read the ENTIRE recent conversations (not just titles) from the rich providers, ChatGPT via
    # the codex connect token (platform-independent), Claude via the user's own browser session cookies,
    # and PREFER that over whatever the frontend read. The frontend reads only the single connected
    # provider, which for a Gemini/antigravity user is a titles-only DOM scrape that can surface a stale
    # topic (the "skincare app" the user hasn't touched in ages). Multiple providers connected? We take
    # all the rich ones and let the clustering pass merge them. Each fails open to "", so a missing one
    # drops. Harvested in PARALLEL under a budget: stacked awaits added a ~15s ChatGPT pull ON TOP of a
    # ~8s Claude pull for ~23s of dead reveal time; gathered they overlap to the slower of the two.
    chatgpt, claude = await asyncio.gather(
        p_budgeted(harvest_chatgpt_usage()),
        p_budgeted(harvest_claude_usage()),
    )
    parts: list[str] = []
    if chatgpt:
        parts.append("ChatGPT conversations:\n" + chatgpt)
    if claude:
        parts.append("Claude conversations:\n" + claude)
    if parts:
        body.usage_summary = "\n\n".join(parts)   # entire-chat content wins over the frontend's titles

    return (await build_prep(load_settings(), body)).model_dump()
