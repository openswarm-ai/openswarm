"""Tool schema definitions for the browser agent delegation MCP server."""

TOOLS = [
    {
        "name": "CreateBrowserAgent",
        "description": (
            "Create a new browser card and run a task on it. A dedicated browser agent "
            "will autonomously perform the task (navigating, clicking, typing, etc.) "
            "and return a summary of actions taken plus a final screenshot. "
            "Use this when you need a fresh browser for a new task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": (
                        "The task for the browser agent to perform. Be specific and "
                        "detailed about what you want accomplished."
                    ),
                },
                "url": {
                    "type": "string",
                    "description": (
                        "Optional starting URL. The new browser will navigate here "
                        "before beginning the task."
                    ),
                },
            },
            "required": ["task"],
        },
    },
    {
        "name": "BrowserAgent",
        "description": (
            "Delegate a browser task to a dedicated browser agent on an existing "
            "browser card. The browser agent will autonomously perform the task "
            "(navigating, clicking, typing, etc.) and return a summary of actions "
            "taken plus a final screenshot."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The ID of the existing browser card to use.",
                },
                "task": {
                    "type": "string",
                    "description": (
                        "The task for the browser agent to perform. Be specific and "
                        "detailed about what you want accomplished."
                    ),
                },
            },
            "required": ["browser_id", "task"],
        },
    },
    {
        "name": "BrowserAgents",
        "description": (
            "Delegate multiple browser tasks to run in parallel, each on an existing "
            "browser card. All tasks execute concurrently and results are returned "
            "together. Use this when you need to perform tasks on multiple web pages "
            "simultaneously."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "Array of browser tasks to run in parallel.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "browser_id": {
                                "type": "string",
                                "description": "The ID of the existing browser card to use.",
                            },
                            "task": {
                                "type": "string",
                                "description": "The task for this browser agent.",
                            },
                        },
                        "required": ["browser_id", "task"],
                    },
                },
            },
            "required": ["tasks"],
        },
    },
]
