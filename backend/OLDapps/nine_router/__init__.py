"""nine_router package — SubApp instance, lifespan, and re-exports.

9Router is a free AI subscription proxy that lets users connect their
Claude/ChatGPT/Gemini subscriptions to OpenSwarm without API keys.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from backend.config.Apps import SubApp
from backend.ports import NINE_ROUTER_PORT

from backend.apps.nine_router.process import is_running, ensure_running, stop
from backend.apps.nine_router.client import (
    get_usage_stats, get_providers, start_oauth,
    poll_oauth, exchange_oauth, get_models,
)

logger = logging.getLogger(__name__)

NINE_ROUTER_URL = f"http://localhost:{NINE_ROUTER_PORT}"
NINE_ROUTER_API = f"{NINE_ROUTER_URL}/api"
NINE_ROUTER_V1 = f"{NINE_ROUTER_URL}/v1"


@asynccontextmanager
async def nine_router_lifespan():
    try:
        await ensure_running()
    except Exception as e:
        logger.warning(f"9Router auto-start failed: {e}")
    yield
    try:
        stop()
    except Exception:
        pass


nine_router = SubApp("nine_router", nine_router_lifespan)
