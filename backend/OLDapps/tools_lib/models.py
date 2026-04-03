from pydantic import BaseModel, Field
from typing import Optional, Any
from uuid import uuid4


class BuiltinTool(BaseModel):
    name: str
    display_name: Optional[str] = None
    description: str
    category: str = "filesystem"
    deferred: bool = False


BUILTIN_TOOLS: list[BuiltinTool] = [
    # Core tools (always loaded)
    BuiltinTool(name="Read", description="Read files and directories from the filesystem", category="filesystem"),
    BuiltinTool(name="Edit", description="Make targeted edits to existing files using search and replace", category="filesystem"),
    BuiltinTool(name="Write", description="Create new files or overwrite existing files", category="filesystem"),
    BuiltinTool(name="Bash", description="Execute shell commands in a terminal", category="system"),
    BuiltinTool(name="Glob", description="Find files matching glob and wildcard patterns", category="search"),
    BuiltinTool(name="Grep", description="Search file contents using regular expressions", category="search"),
    BuiltinTool(name="AskUserQuestion", description="Ask the user a question and wait for their response", category="interaction"),
    # Deferred tools (loaded via ToolSearch on demand)
    BuiltinTool(name="WebSearch", description="Search the web for real-time information", category="search", deferred=True),
    BuiltinTool(name="WebFetch", description="Fetch and read content from a URL", category="search", deferred=True),
    BuiltinTool(name="NotebookEdit", description="Edit Jupyter notebook cells", category="filesystem", deferred=True),
    BuiltinTool(name="TodoWrite", description="Write and manage a structured todo list", category="planning", deferred=True),
    BuiltinTool(name="EnterPlanMode", description="Enter plan mode for designing solutions", category="planning", deferred=True),
    BuiltinTool(name="ExitPlanMode", description="Exit plan mode and return to execution", category="planning", deferred=True),
    BuiltinTool(name="EnterWorktree", description="Enter a git worktree for isolated work", category="system", deferred=True),
    BuiltinTool(name="TaskOutput", description="Read output from a background task", category="system", deferred=True),
    BuiltinTool(name="TaskStop", description="Stop a running background task", category="system", deferred=True),
    BuiltinTool(name="CronCreate", description="Create a scheduled or recurring task", category="scheduling", deferred=True),
    BuiltinTool(name="CronList", description="List all scheduled tasks", category="scheduling", deferred=True),
    BuiltinTool(name="CronDelete", description="Delete a scheduled task", category="scheduling", deferred=True),
    BuiltinTool(name="RenderOutput", description="Render a reusable View artifact with structured input data", category="views", deferred=True),
    # Agent tools
    BuiltinTool(name="Agent", display_name="CreateAgent", description="Spawn a sub-agent to handle a complex subtask", category="agents"),
    BuiltinTool(name="InvokeAgent", description="Invoke a copy of an existing agent with a new message, preserving full conversation context", category="agents"),
    # Browser delegation tools (Layer 1 — what the main agent calls)
    BuiltinTool(name="CreateBrowserAgent", description="Create a new browser and run a task on it", category="browser_delegation"),
    BuiltinTool(name="BrowserAgent", description="Delegate a browser task to an existing browser agent", category="browser_delegation"),
    BuiltinTool(name="BrowserAgents", description="Run multiple browser tasks in parallel on existing browsers", category="browser_delegation"),
    # Browser action tools (Layer 2 — what the sub-agent executes)
    BuiltinTool(name="BrowserScreenshot", description="Capture a screenshot of the browser page", category="browser_action"),
    BuiltinTool(name="BrowserNavigate", description="Navigate the browser to a URL", category="browser_action"),
    BuiltinTool(name="BrowserClick", description="Click an element by CSS selector", category="browser_action"),
    BuiltinTool(name="BrowserType", description="Type text into an input element", category="browser_action"),
    BuiltinTool(name="BrowserEvaluate", description="Execute JavaScript in the browser", category="browser_action"),
    BuiltinTool(name="BrowserGetText", description="Get visible text content of the page", category="browser_action"),
    BuiltinTool(name="BrowserGetElements", description="List interactive elements with CSS selectors", category="browser_action"),
    BuiltinTool(name="BrowserScroll", description="Scroll the page up or down", category="browser_action"),
    BuiltinTool(name="BrowserWait", description="Wait for page loads or animations", category="browser_action"),
]


class ToolDefinition(BaseModel):
    model_config = {"extra": "ignore"}

    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    command: str = ""
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, str] = Field(default_factory=dict)
    auth_type: str = "none"
    auth_status: str = "none"
    oauth_provider: Optional[str] = None
    oauth_tokens: dict[str, Any] = Field(default_factory=dict)
    tool_permissions: dict[str, Any] = Field(default_factory=dict)
    connected_account_email: Optional[str] = None
    enabled: bool = True


class ToolCreate(BaseModel):
    name: str
    description: str = ""
    command: str = ""
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, str] = Field(default_factory=dict)
    auth_type: str = "none"
    auth_status: str = "none"
    oauth_provider: Optional[str] = None


class ToolUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    command: Optional[str] = None
    mcp_config: Optional[dict[str, Any]] = None
    credentials: Optional[dict[str, str]] = None
    auth_type: Optional[str] = None
    auth_status: Optional[str] = None
    oauth_provider: Optional[str] = None
    oauth_tokens: Optional[dict[str, Any]] = None
    tool_permissions: Optional[dict[str, Any]] = None
    connected_account_email: Optional[str] = None
    enabled: Optional[bool] = None
