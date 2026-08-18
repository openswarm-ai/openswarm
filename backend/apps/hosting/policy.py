"""Hosting policy seam.

On the desktop every request is the local user: nothing is scoped by owner, and every process-wide
answer below is the permissive default. A hosted (multi-tenant) build supplies its own policy through
`p_provider`; the rest of the app only ever talks to `REQUEST_SCOPE` (a FastAPI dependency) and
`hosting_policy()`, so no route or manager knows which build it is running in.

Everything here is a plain default: the desktop scope allows, filters nothing, stamps no owner, and
`hosting_policy()` answers "not hosted" to every question.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Tuple, TypeVar

from fastapi import Request, params
from typeguard import typechecked

T = TypeVar("T")

#: The built-in tools that change the machine or spawn work. A hosted build may deny them to trial
#: callers; they are also the fail-closed answer when an owned session's policy cannot be consulted.
MUTATING_BUILTINS: frozenset = frozenset({
    "Agent",
    "Bash",
    "CronCreate",
    "CronDelete",
    "Edit",
    "EnterWorktree",
    "InvokeAgent",
    "NotebookEdit",
    "TodoWrite",
    "Write",
})


class RequestScope:
    """Who owns the current request, and what it may do. Desktop: nobody owns anything and
    everything is allowed. A hosted build returns a subclass bound to the caller's account."""

    #: True in a hosted build once the caller is resolved; the desktop is never hosted.
    hosted: bool = False
    #: The caller's account id in a hosted build; None on the desktop.
    owner_id: Optional[str] = None

    # ---- ownership -----------------------------------------------------------------------
    @typechecked
    def require_owner_of(self, owner_account_id: Optional[str]) -> None:
        """Raise unless the caller owns the resource stamped with `owner_account_id`."""

    @typechecked
    def filter_owned(self, items: Iterable[T]) -> List[T]:
        """Keep only the caller's items (items carry `owner_account_id`)."""
        return list(items)

    @typechecked
    def stamp_owner(self, item: Any) -> None:
        """Mark a freshly created resource as the caller's (no-op on the desktop)."""

    @typechecked
    def owner_for_new_resource(self, requested: Optional[str]) -> Optional[str]:
        """The owner a new resource is created under: whatever the caller asked for on the desktop,
        always the caller itself in a hosted build."""
        return requested

    @typechecked
    def require_local_operator(self, what: str) -> None:
        """Raise unless the caller is the machine's own operator (always, on the desktop). `what`
        names the operation for the refusal message."""

    # ---- agents ---------------------------------------------------------------------------
    @typechecked
    def sanitize_launch_config(self, config: T) -> T:
        return config

    @typechecked
    async def admit_launch(
        self, config: Any, launch: Callable[[Any], Awaitable[Any]],
    ) -> Tuple[Any, bool]:
        """Run `launch(config)` under this scope's admission rules. Returns the session and whether
        the caller should still run the launch's first turn (a hosted build may already have
        recorded the launch as the durable side effect and answers False)."""
        return await launch(config), True

    @typechecked
    def admit_prompt(
        self,
        session: Any,
        *,
        requested_mode: Optional[str],
        forced_tools: Optional[List[str]],
        side_effect_payload: dict,
    ) -> bool:
        """Admit a prompt/edit for `session`. Returns True when the request was a replay of an
        already-admitted one (the caller then answers `replayed` instead of running it)."""
        return False

    @typechecked
    async def authorize_approval(
        self,
        approval_session_id: Optional[str],
        session_lookup: Callable[[str], Awaitable[Any]],
    ) -> None:
        """Raise unless the caller may answer the approval that `approval_session_id` is waiting on;
        `session_lookup` resolves the owning session when the scope needs to check it."""

    @typechecked
    def resolve_approval(self, request_id: str, decision: dict, approval_session_id: Optional[str]) -> bool:
        """Deliver an approval decision through the scope's own channel. Returns True when it did;
        False means the caller delivers it through the desktop path."""
        return False

    # ---- outputs --------------------------------------------------------------------------
    @typechecked
    def require_app_builder_enabled(self) -> None:
        """Raise unless this caller may use the App Builder (always allowed on the desktop)."""

    @typechecked
    def register_seeded_workspace(self, workspace_id: str, meta: Optional[dict]) -> Optional[str]:
        """Record a seeded workspace as the caller's output when the build tracks ownership; returns
        the output id it now maps to, or None when nothing is recorded (the desktop)."""
        return None


class HostingPolicy:
    """Process-wide answers. Desktop defaults throughout."""

    enabled: bool = False

    @typechecked
    def request_scope(self, request: Request) -> RequestScope:
        return DESKTOP_SCOPE

    @typechecked
    def owned_workspace_root(self, owner_account_id: Optional[str]) -> Optional[str]:
        """The per-owner workspace root a session's cwd must live under, or None when sessions use
        the ordinary cwd."""
        return None

    @typechecked
    def builtin_tool_denials(self, session: Any) -> frozenset:
        """Built-in tools this session may not use (empty on the desktop)."""
        return frozenset()

    @typechecked
    def tool_update_restricted(self, tool: Any, body: Any) -> bool:
        """True when a tools-library update must be refused for this build."""
        return False

    @typechecked
    def workflows_disabled(self) -> bool:
        return False

    @typechecked
    def blocks_loopback_targets(self) -> bool:
        """True when SSRF checks must treat loopback as a network target (never on the desktop,
        where local previews are the point)."""
        return False

    @typechecked
    def hydrate_settings(self, settings: Any, save: Callable[[Any], None]) -> Any:
        """Give the build a chance to pin settings at boot (a hosted build lends a provider key);
        the desktop returns them untouched."""
        return settings

    @typechecked
    def present_settings(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """The settings payload a client may see; the desktop shows everything, a hosted build masks
        what it lent."""
        return payload


DESKTOP_SCOPE = RequestScope()
DESKTOP_POLICY = HostingPolicy()

# A build that hosts replaces this with a provider that resolves its own policy.
p_provider: Callable[[], HostingPolicy] = lambda: DESKTOP_POLICY


@typechecked
def hosting_policy() -> HostingPolicy:
    return p_provider()


@typechecked
def request_scope(request: Request) -> RequestScope:
    """Resolve the caller's scope for a request (what REQUEST_SCOPE injects)."""
    return hosting_policy().request_scope(request)


class p_RequestScopeDependency(RequestScope, params.Depends):
    """The route default `scope: RequestScope = REQUEST_SCOPE`. FastAPI sees a dependency and injects
    the caller's scope; a route called directly (tests do) gets this object, which is the desktop scope."""

    def __init__(self) -> None:
        params.Depends.__init__(self, dependency=request_scope)


REQUEST_SCOPE: RequestScope = p_RequestScopeDependency()
