"""The delegation tool names, in ONE place, because two lists of names that must agree will not.

`BrowserAgents` was registered as a real tool and left out of the wedge-exemption set, so the
quick-tool watchdog armed on every PARALLEL browser run. It does not fire at 25s -- the ENG-353
heartbeat check extends a slow-but-alive call to 120s and then 300s -- but `wedge_verdict` kills
unconditionally at the 300s hard ceiling, and immediately whenever the sidecar heartbeat goes stale.
So any parallel browser run past five minutes was terminated, and a busy sidecar could lose one
sooner. The singular `BrowserAgent` was exempt, so the bug was invisible to anyone testing one
browser at a time and looked like "browser use disconnects constantly" to the one person running
several (Haik, ~100% failure over weeks).

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
