"""The delegation tool names, in ONE place, because two lists of names that must agree will not.

`BrowserAgents` was registered as a real tool and left out of the wedge-exemption set, so every
PARALLEL browser run was shot 25 seconds in by the quick-tool watchdog. The singular `BrowserAgent`
was exempt, so the bug was invisible to anyone testing one browser at a time, and looked like "browser
use disconnects constantly" to the one person running several (Haik, ~100% failure over weeks).

Nothing checked the two lists against each other. Now there is only one list.
"""

from typing import List, Set

# Every tool that hands work to a browser, an app, or another agent. These BLOCK for as long as the
# delegated run takes, so no quick-tool deadline may apply to them.
BROWSER_DELEGATION_TOOLS: List[str] = [
    "CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "AppAgent",
]

# Everything else that legitimately blocks on a human, a model, or a whole delegated run.
OTHER_BLOCKING_TOOLS: Set[str] = {
    "AskUI", "AskUserQuestion", "ShowUI",
    "SpawnAgent", "InvokeAgent", "RequestHumanIntervention",
    "MCPSearch", "MCPActivate",
    "RunToolScript",
}

BLOCKING_TOOLS: Set[str] = set(BROWSER_DELEGATION_TOOLS) | OTHER_BLOCKING_TOOLS
