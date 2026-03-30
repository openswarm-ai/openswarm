"""Tool categorization — pure data + logic, no routes."""

from __future__ import annotations

_READ_PREFIXES = ("get", "list", "read", "search", "fetch", "find", "query", "count", "check", "describe", "show", "download", "browse", "analy", "explain")
_WRITE_PREFIXES = ("create", "write", "delete", "update", "send", "remove", "modify", "add", "set", "put", "post", "patch", "insert", "move", "copy", "rename", "archive", "trash", "publish", "approve", "reject")

_SERVICE_RULES: list[tuple[list[str], str, str]] = [
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
    (["subreddit"], "Subreddits", "Reddit"),
    (["search_reddit"], "Search", "Reddit"),
    (["post_detail"], "Posts", "Reddit"),
    (["user_analysis"], "Users", "Reddit"),
    (["reddit_explain"], "Reference", "Reddit"),
    (["sequentialthinking", "thinking"], "Thinking", "Sequential Thinking"),
    (["create_entities", "create_relations", "add_observations", "delete_entities",
      "delete_observations", "delete_relations", "read_graph", "search_nodes",
      "open_nodes"], "Knowledge Graph", "Memory"),
    (["read_file", "read_multiple_files", "write_file", "edit_file",
      "create_directory", "list_directory", "directory_tree", "move_file",
      "search_files", "get_file_info", "list_allowed_directories"], "Files", "Filesystem"),
    (["browser_navigate", "browser_screenshot", "browser_click", "browser_fill",
      "browser_select", "browser_hover", "browser_evaluate", "browser_console",
      "browser_tab", "browser_close", "browser_resize", "browser_snapshot",
      "browser_wait", "browser_pdf", "browser_drag"], "Browser", "Playwright"),
    (["git_status", "git_diff", "git_diff_unstaged", "git_diff_staged",
      "git_commit", "git_log", "git_add", "git_reset", "git_show",
      "git_create_branch", "git_checkout", "git_list_branches", "git_init",
      "git_clone"], "Repository", "Git"),
    (["get_transcript"], "Transcripts", "YouTube"),
    (["execute_command", "read_output", "force_terminate", "list_sessions",
      "list_processes", "kill_process", "block_command", "unblock_command",
      "read_file", "write_file", "search_code", "list_directory",
      "get_file_info", "edit_block"], "System", "Desktop Commander"),
    (["repository", "issue", "pull_request", "commit", "branch", "fork", "star",
      "create_issue", "list_issues", "get_issue", "create_pull_request",
      "list_commits", "search_repositories", "create_repository",
      "get_file_contents", "push_files", "create_branch",
      "search_code", "search_issues"], "Repository", "GitHub"),
    (["channel", "slack_message", "thread", "reply", "workspace",
      "list_channels", "post_message", "reply_to_thread", "search_messages",
      "get_channel_history", "get_thread_replies", "get_users",
      "get_user_profile"], "Messaging", "Slack"),
    (["notion_page", "database", "block", "create_page", "update_page",
      "search_pages", "get_page", "get_database", "query_database",
      "create_database", "append_block_children"], "Pages", "Notion"),
    (["play", "pause", "skip", "playlist", "track", "album", "artist",
      "search_tracks", "get_playlist", "get_currently_playing",
      "add_to_playlist", "create_playlist", "get_recommendations",
      "get_top_items"], "Music", "Spotify"),
    (["figma", "design", "component", "style", "node",
      "get_file", "get_file_nodes", "get_image", "get_comments",
      "get_team_projects", "get_project_files"], "Design", "Figma"),
    (["airtable", "base", "record", "field", "view",
      "list_records", "get_record", "create_record", "update_record",
      "delete_record", "list_bases", "get_base_schema"], "Data", "Airtable"),
    (["hubspot", "contact", "deal", "company", "ticket", "pipeline",
      "crm", "engagement", "association"], "CRM", "HubSpot"),
    (["discord", "guild", "server", "channel_message", "send_message",
      "get_messages", "get_guilds", "get_channels", "add_reaction"], "Messaging", "Discord"),
    (["tweetsave", "get_tweet", "get_thread", "to_blog", "batch",
      "extract_media"], "Tweets", "Twitter"),
    (["shopify", "introspect", "graphql", "search_dev_docs", "liquid",
      "polaris", "admin_api", "storefront_api"], "Developer", "Shopify"),
    (["zoom", "meeting", "recording", "participant", "webinar",
      "create_meeting", "list_meetings", "get_meeting", "delete_meeting",
      "update_meeting"], "Meetings", "Zoom"),
    (["outlook", "onedrive", "ms365", "microsoft", "mail_folder",
      "email", "calendar_event", "contact", "drive_item"], "Mail & Files", "Microsoft 365"),
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


def _extract_service(name: str) -> tuple[str, str]:
    lower = name.lower()
    for keywords, display, group in _SERVICE_RULES:
        for kw in keywords:
            if kw in lower:
                return display, group
    return "Other", ""
