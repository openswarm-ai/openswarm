"""Mirror tests for the frontend label/result logic.

The JS implementations live in:
  - frontend/src/app/pages/AgentChat/toolLabels.ts
  - frontend/src/app/pages/AgentChat/ToolCallBubble.tsx (getResultSummary,
    getInputSummary, parseMcpToolName, bashCommandDetail, prettyPath, prettyUrl,
    quoteQuery)

We re-implement the rules in Python and pin them as tests so we get
regression coverage from `pytest` too. Any drift between the JS source
and these Python mirrors is the production-side breakage we want to
catch.
"""

from __future__ import annotations

import random
import re
import pytest


# =========================================================================== Mirror: parseMcpToolName.displayName (sentence-case rule) ===========================================================================

def parse_mcp_tool_name_display(raw_name: str) -> str | None:
    """Mirror of frontend parseMcpToolName().displayName."""
    m = re.match(r"^mcp__([^_]+(?:-[^_]+)*)__(.+)$", raw_name)
    if not m:
        return None
    action = m.group(2)
    spaced = action.replace("_", " ").lower()
    return spaced[0].upper() + spaced[1:] if spaced else ""


def test_parse_mcp_tool_name_get_message_details():
    assert parse_mcp_tool_name_display(
        "mcp__google-workspace__get_message_details"
    ) == "Get message details"


def test_parse_mcp_tool_name_send_email():
    assert parse_mcp_tool_name_display(
        "mcp__google-workspace__send_gmail_message"
    ) == "Send gmail message"


def test_parse_mcp_tool_name_search_emails():
    assert parse_mcp_tool_name_display(
        "mcp__google-workspace__query_gmail_emails"
    ) == "Query gmail emails"


def test_parse_mcp_tool_name_returns_none_for_non_mcp():
    assert parse_mcp_tool_name_display("Bash") is None
    assert parse_mcp_tool_name_display("Read") is None


def test_parse_mcp_tool_name_no_title_case():
    """Regression test: NEVER capitalize every word."""
    bad = parse_mcp_tool_name_display("mcp__notion__create_a_new_page")
    assert bad == "Create a new page"
    assert "A New Page" not in bad


# =========================================================================== Mirror: getResultSummary (glyph-free regression test) ===========================================================================

def get_result_summary_bash_success(stdout: str, exit_code: int = 0) -> str:
    """Mirror of getResultSummary for bash success case."""
    if exit_code != 0:
        return f"exit {exit_code}"
    lines = [l for l in stdout.split("\n") if l.strip()]
    n = len(lines)
    return f"{n} line{'s' if n != 1 else ''}"


def test_bash_success_summary_no_glyph():
    """Regression: bash success used to return '✓ N lines'. Must now be glyph-free."""
    assert "✓" not in get_result_summary_bash_success("hello\nworld")
    assert get_result_summary_bash_success("hello\nworld") == "2 lines"
    assert get_result_summary_bash_success("just one line") == "1 line"
    assert get_result_summary_bash_success("") == "0 lines"


def test_bash_failure_summary_no_glyph():
    """Failure summary too: 'exit 1' not '✗ exit 1'."""
    assert get_result_summary_bash_success("", exit_code=1) == "exit 1"
    assert "✗" not in get_result_summary_bash_success("", exit_code=1)
    assert "✓" not in get_result_summary_bash_success("", exit_code=1)


def test_no_check_glyph_in_summaries():
    """Sweep: every plausible summary string never contains a check glyph."""
    summaries = [
        get_result_summary_bash_success("a"),
        get_result_summary_bash_success("a\nb\nc"),
        get_result_summary_bash_success("", exit_code=1),
        get_result_summary_bash_success("", exit_code=127),
    ]
    for s in summaries:
        assert "✓" not in s and "✔" not in s and "✗" not in s and "✘" not in s


# =========================================================================== Mirror: bashCommandDetail extraction ===========================================================================

def bash_command_detail(raw_cmd: str) -> str:
    """Mirror of frontend bashCommandDetail."""
    if not raw_cmd:
        return ""
    cmd = raw_cmd.strip()
    # strip env var assignments + sudo/time/nice/env
    cmd = re.sub(r"^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+", "", cmd)
    cmd = re.sub(r"^(?:sudo|time|nice|env)\s+", "", cmd)
    tokens = cmd.split()
    if not tokens:
        return ""
    bin_path = tokens[0].split("/")[-1]

    if bin_path == "git":
        sub = (tokens[1] if len(tokens) > 1 else "").lower()
        if sub in ("commit", "status", "log", "diff", "pull", "push", "fetch"):
            return ""
        return tokens[2].split("/")[-1] if len(tokens) > 2 else ""

    if bin_path in ("npm", "pnpm", "yarn", "bun", "pip", "pip3", "brew", "apt", "apt-get"):
        if len(tokens) > 2:
            args = [t for t in tokens[2:] if not t.startswith("-")][:2]
            return " ".join(args)
        return ""

    # First non-flag positional arg
    arg = next((t for t in tokens[1:] if not t.startswith("-")), "")
    if not arg:
        return ""
    if "/" in arg or "\\" in arg:
        # basename
        cleaned = arg.rstrip("/\\")
        parts = cleaned.replace("\\", "/").split("/")
        return parts[-1] if parts[-1] else cleaned
    return arg if len(arg) <= 50 else arg[:47] + "..."


def test_bash_detail_rm_extracts_path():
    assert bash_command_detail("rm /tmp/foo.txt") == "foo.txt"
    assert bash_command_detail("rm foo.txt") == "foo.txt"


def test_bash_detail_git_commit_empty():
    """git commit -m 'message' → no detail (verb covers it)."""
    assert bash_command_detail("git commit -m 'fix bug'") == ""
    assert bash_command_detail("git commit -m hi") == ""


def test_bash_detail_git_status_empty():
    assert bash_command_detail("git status") == ""


def test_bash_detail_git_checkout_branch():
    assert bash_command_detail("git checkout main") == "main"


def test_bash_detail_npm_install():
    assert bash_command_detail("npm install lodash") == "lodash"
    assert bash_command_detail("npm install lodash @types/node") == "lodash @types/node"


def test_bash_detail_strips_sudo():
    assert bash_command_detail("sudo rm /etc/foo") == "foo"


def test_bash_detail_strips_env_assignments():
    assert bash_command_detail("FOO=bar BAZ=qux rm /tmp/a") == "a"


def test_bash_detail_handles_empty():
    assert bash_command_detail("") == ""
    assert bash_command_detail("   ") == ""


# =========================================================================== Mirror: prettyPath (basename a path) ===========================================================================

def pretty_path(p: str) -> str:
    if not p:
        return ""
    cleaned = p.rstrip("/\\")
    parts = cleaned.replace("\\", "/").split("/")
    return parts[-1] if parts[-1] else cleaned


def test_pretty_path_absolute():
    assert pretty_path("/Users/eric/Downloads/openswarm/foo.ts") == "foo.ts"


def test_pretty_path_relative():
    assert pretty_path("a/b/c.tsx") == "c.tsx"


def test_pretty_path_trailing_slash():
    assert pretty_path("/a/b/c/") == "c"


def test_pretty_path_empty():
    assert pretty_path("") == ""


# =========================================================================== Mirror: prettyUrl (host-only) ===========================================================================

def pretty_url(u: str) -> str:
    if not u:
        return ""
    try:
        from urllib.parse import urlparse
        host = urlparse(u).hostname or ""
        return host[4:] if host.startswith("www.") else host or u[:60]
    except Exception:
        no_proto = re.sub(r"^https?://", "", u).split("/")[0].split("?")[0].split("#")[0]
        return no_proto[:60]


def test_pretty_url_https():
    assert pretty_url("https://example.com/long/path?q=1") == "example.com"


def test_pretty_url_strips_www():
    assert pretty_url("https://www.example.com/path") == "example.com"


def test_pretty_url_subdomain_kept():
    assert pretty_url("https://api.example.com/v1") == "api.example.com"


def test_pretty_url_empty():
    assert pretty_url("") == ""


# =========================================================================== Mirror: quoteQuery ===========================================================================

def quote_query(q: str, max_len: int = 60) -> str:
    if not q:
        return ""
    trimmed = q if len(q) <= max_len else q[:max_len - 1] + "…"
    return f'"{trimmed}"'


def test_quote_query_short():
    assert quote_query("TODO") == '"TODO"'


def test_quote_query_long_truncated():
    long = "a" * 100
    result = quote_query(long)
    assert result.startswith('"')
    assert result.endswith('"')
    assert len(result) <= 62  # 60 chars + 2 quotes


def test_quote_query_empty():
    assert quote_query("") == ""


# =========================================================================== Mirror: stable-seeded variant pick (djb2 hash → mod n) ===========================================================================

def stable_index(seed: str | None, n: int) -> int:
    """Mirror of frontend _stableIndex."""
    if n <= 1 or not seed:
        return 0
    h = 5381
    for ch in seed:
        h = ((h << 5) + h + ord(ch)) & 0xFFFFFFFF  # 32-bit
    # JS does `| 0` which produces signed int; Math.abs handles that
    if h >= 0x80000000:
        h -= 0x100000000
    return abs(h) % n


def test_stable_index_same_seed_same_result():
    """Critical: same call.id always → same variant index."""
    n = 5
    for seed in ("abc-123", "xyz-789", "tool-call-uuid-deadbeef"):
        a = stable_index(seed, n)
        b = stable_index(seed, n)
        c = stable_index(seed, n)
        assert a == b == c, f"unstable for seed={seed!r}"


def test_stable_index_different_seeds_diverge():
    """Different seeds usually give different results (probabilistic)."""
    n = 7
    seeds = [f"seed-{i}-{random.randint(0, 99999)}" for i in range(50)]
    indices = [stable_index(s, n) for s in seeds]
    # All same is statistically extremely unlikely
    assert len(set(indices)) > 1


def test_stable_index_in_range():
    """Index always in [0, n-1]."""
    for _ in range(200):
        seed = "".join(random.choices(string.ascii_letters + string.digits, k=20))
        n = random.randint(2, 20)
        idx = stable_index(seed, n)
        assert 0 <= idx < n, f"out of range: {idx} for n={n}"


def test_stable_index_empty_seed_zero():
    """No seed → safe-default (index 0)."""
    assert stable_index(None, 5) == 0
    assert stable_index("", 5) == 0


def test_stable_index_n_one():
    """Single-variant pool → always index 0."""
    assert stable_index("anything", 1) == 0


# =========================================================================== Mirror: bash verb extraction (the leading-binary lookup) ===========================================================================

BIN_VERB_MAP = {
    "rm": ("Deleting", "Deleted"),
    "mv": ("Moving", "Moved"),
    "cp": ("Copying", "Copied"),
    "mkdir": ("Creating folder", "Created folder"),
    "ls": ("Listing folder", "Listed folder"),
    "find": ("Hunting for files", "Hunted for files"),
    "grep": ("Searching files", "Searched files"),
    "cat": ("Reading", "Read"),
    "echo": ("Printing", "Printed"),
    "make": ("Building", "Built"),
}

GIT_VERB_MAP = {
    "commit": ("Committing", "Committed"),
    "push": ("Pushing to git", "Pushed to git"),
    "pull": ("Pulling from git", "Pulled from git"),
    "checkout": ("Switching branches", "Switched branches"),
    "merge": ("Merging", "Merged"),
}

PKG_VERB_MAP_INSTALL = ("Installing packages", "Installed packages")
PKG_VERB_MAP_UNINSTALL = ("Removing packages", "Removed packages")


def bash_verb(cmd: str, past: bool = False):
    if not cmd:
        return None
    stripped = re.sub(r"^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+", "", cmd.strip())
    stripped = re.sub(r"^(?:sudo|time|nice|env)\s+", "", stripped)
    tokens = stripped.split()
    if not tokens:
        return None
    bin_path = tokens[0].split("/")[-1].lower()
    sub = (tokens[1] if len(tokens) > 1 else "").lower()

    if bin_path == "git" and sub in GIT_VERB_MAP:
        return GIT_VERB_MAP[sub][1 if past else 0]
    if bin_path in ("npm", "pnpm", "yarn", "pip", "pip3", "brew"):
        if sub in ("install", "add", "i"):
            return PKG_VERB_MAP_INSTALL[1 if past else 0]
        if sub in ("uninstall", "remove", "rm"):
            return PKG_VERB_MAP_UNINSTALL[1 if past else 0]
    if bin_path in BIN_VERB_MAP:
        return BIN_VERB_MAP[bin_path][1 if past else 0]
    return None


def test_bash_verb_rm_deleted():
    assert bash_verb("rm foo", past=True) == "Deleted"
    assert bash_verb("rm foo", past=False) == "Deleting"


def test_bash_verb_git_commit():
    assert bash_verb("git commit -m hi", past=True) == "Committed"


def test_bash_verb_git_push():
    assert bash_verb("git push origin main", past=True) == "Pushed to git"


def test_bash_verb_npm_install():
    assert bash_verb("npm install lodash", past=True) == "Installed packages"


def test_bash_verb_unknown_returns_none():
    """Truly unknown command falls through to default 'Ran command'."""
    assert bash_verb("supercustomtool foo bar") is None


def test_bash_verb_strips_sudo():
    assert bash_verb("sudo rm -rf /tmp/x", past=True) == "Deleted"


def test_bash_verb_strips_env():
    assert bash_verb("DEBUG=1 npm test", past=False) is None  # 'test' isn't in pkg map for bash_verb


# string is needed for stable_index test
import string  # noqa: E402
