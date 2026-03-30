"""Backward-compatible shim — re-exports from the browser sub-package."""

from backend.apps.agents.browser.runner import (  # noqa: F401
    run_browser_agent,
    run_browser_agents,
)
from backend.apps.agents.browser.executor import (  # noqa: F401
    execute_browser_tool,
)
