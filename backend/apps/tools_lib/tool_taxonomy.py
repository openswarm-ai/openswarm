_READ_PREFIXES = ("get", "list", "read", "search", "fetch", "find", "query", "count", "check", "describe", "show", "download", "browse", "analy", "explain")
_WRITE_PREFIXES = ("create", "write", "delete", "update", "send", "remove", "modify", "add", "set", "put", "post", "patch", "insert", "move", "copy", "rename", "archive", "trash", "publish", "approve", "reject")


_SERVICE_RULES: list[tuple[list[str], str, str]] = [
    # (keywords, service_name, group)
    # Google Workspace
    (["gmail"], "Gmail", "Google"),
    (["drive"], "Drive", "Google"),
    (["calendar", "event", "freebusy"], "Calendar", "Google"),
    (["spreadsheet", "sheet"], "Sheets", "Google"),
    (["doc", "paragraph", "table"], "Docs", "Google"),
    (["chat", "space", "reaction", "message"], "Chat", "Google"),
    (["form", "publish_settings"], "Forms", "Google"),
    (["presentation", "slide", "page"], "Slides", "Google"),
    (["task_list", "task"], "Tasks", "Google"),
    (["contact"], "Contacts", "Google"),
    (["script", "deployment", "version", "trigger"], "Apps Script", "Google"),
    (["search_custom", "search_engine"], "Search", "Google"),
    # YouTube
    (["transcript", "caption"], "Transcripts", "YouTube"),
    (["video_detail", "video_comment", "video_categor", "video_engagement"], "Videos", "YouTube"),
    (["search_video", "trending_video"], "Search", "YouTube"),
    (["channel_stat", "channel_top"], "Channels", "YouTube"),
    # Reddit (before Twitter so "search_reddit" etc. don't mis-match)
    (["subreddit"], "Subreddits", "Reddit"),
    (["search_reddit"], "Search", "Reddit"),
    (["post_detail"], "Posts", "Reddit"),
    (["user_analysis"], "Users", "Reddit"),
    (["reddit_explain"], "Reference", "Reddit"),
]


def _categorize_tool(name: str) -> str:
    lower = name.lower().replace("_", " ").replace("-", " ").strip()
    for word in lower.split():
        for prefix in _READ_PREFIXES:
            if word.startswith(prefix):
                return "read"
        for prefix in _WRITE_PREFIXES:
            if word.startswith(prefix):
                return "write"
    return "write"


def _integration_domain(integration: str) -> str:
    """Which curated _SERVICE_RULES set applies to this integration, if any. The Google rules use
    generic words (message/table/page/doc/script) that otherwise mis-tag Slack/Notion/Airtable/M365."""
    n = (integration or "").lower()
    if "google" in n:
        return "Google"
    if "youtube" in n:
        return "YouTube"
    if "reddit" in n:
        return "Reddit"
    return ""


def _extract_service(name: str, integration: str) -> tuple[str, str]:
    """Map a tool name to (service, group). Curated rulesets apply only to the integration they were
    written for; every other integration groups under its own name so it isn't mislabeled as Google."""
    domain = _integration_domain(integration)
    if domain:
        lower = name.lower()
        for keywords, display, group in _SERVICE_RULES:
            if group != domain:
                continue
            for kw in keywords:
                if kw in lower:
                    return display, group
        return "Other", ""
    # No curated rules: one service per integration, grouped under itself.
    return (integration or "Other"), ""


def _classify_services(
    tool_names: list[str], integration: str
) -> tuple[dict[str, dict[str, list[str]]], dict[str, list[str]], list[str], list[str]]:
    """Bucket tool names into services + service groups + read/write categories for one integration."""
    services: dict[str, dict[str, list[str]]] = {}
    service_groups: dict[str, list[str]] = {}
    for name in tool_names:
        cat = _categorize_tool(name)
        svc, group = _extract_service(name, integration)
        services.setdefault(svc, {"read": [], "write": []})
        services[svc][cat].append(name)
        if group:
            service_groups.setdefault(group, [])
            if svc not in service_groups[group]:
                service_groups[group].append(svc)
    all_read = [n for s in services.values() for n in s["read"]]
    all_write = [n for s in services.values() for n in s["write"]]
    return services, service_groups, all_read, all_write
