"""What a user is told when an MCP server dies on them.

The Slack case, captured live: the server exits with a JSON log line carrying a Go goroutine dump,
and the app rendered the whole thing. The user sees "MCP stdio process exited unexpectedly: at
TracingChannel.traceSync (node:diagnostics_channel:322:14) { status: 1, ... }" and has no way to
learn the actual cause, which was simply that their Slack sign-in had expired.

The opposite failure matters too: inventing a friendly reason for something we do not recognise
sends people to fix the wrong thing, so anything unknown keeps its real words.
"""
from backend.apps.tools_lib.mcp_failure_reason import readable_mcp_failure

# Byte-for-byte what slack-mcp-server printed when run with the stored tokens on 2026-08-02.
SLACK_REAL = (
    '{"level":"fatal","timestamp":"2026-08-02T21:16:01-07:00","message":'
    '"Authentication failed - check your Slack tokens","app":"slack-mcp-server",'
    '"error":"invalid_auth","stacktrace":"github.com/korotovsky/slack-mcp-server/pkg/'
    'provider.newWithXOXC\\n\\t/Users/runner/work/slack-mcp-server/pkg/provider/api.go:761\\n'
    'runtime.main\\n\\t/Users/runner/hostedtoolcache/go/1.25.9/arm64/src/runtime/proc.go:285"}'
)

SLACK_NO_TOKENS = (
    '{"level":"fatal","message":"Authentication required: Either SLACK_MCP_XOXP_TOKEN, '
    'SLACK_MCP_XOXB_TOKEN, or both SLACK_MCP_XOXC_TOKEN and SLACK_MCP_XOXD_TOKEN must be provided",'
    '"app":"slack-mcp-server","stacktrace":"provider.New\\n\\tapi.go:682"}'
)


def test_the_real_slack_failure_becomes_reconnect_advice():
    out = readable_mcp_failure(SLACK_REAL)
    assert "sign-in has expired" in out
    assert "Reconnect" in out


def test_no_stacktrace_survives_into_the_message():
    out = readable_mcp_failure(SLACK_REAL)
    for leak in ("goroutine", "github.com", ".go:", "runtime.main", "stacktrace", "{"):
        assert leak not in out, f"{leak!r} leaked into what the user reads"


def test_missing_tokens_reads_differently_from_expired_ones():
    # Never signed in and signed-in-but-stale need different actions, so they cannot share a string.
    never = readable_mcp_failure(SLACK_NO_TOKENS)
    expired = readable_mcp_failure(SLACK_REAL)
    assert "signed in" in never
    assert never != expired


def test_revoked_access_says_so():
    assert "revoked" in readable_mcp_failure('{"error":"token_revoked","message":"bad"}').lower()


def test_a_missing_permission_points_at_reconnecting():
    out = readable_mcp_failure('{"error":"missing_scope","message":"needs channels:read"}')
    assert "permission" in out and "Reconnect" in out


def test_a_missing_binary_is_named_plainly():
    out = readable_mcp_failure("spawn npx ENOENT")
    assert "could not be found" in out


def test_rate_limiting_tells_you_to_wait_not_to_reconnect():
    out = readable_mcp_failure("Error: rate limited, retry after 30s")
    assert "rate-limiting" in out
    assert "Reconnect" not in out


def test_an_unknown_json_failure_keeps_its_real_message():
    # We must not invent a cause. Surface the server's own sentence, minus the scaffolding.
    out = readable_mcp_failure('{"level":"fatal","message":"database is locked","stacktrace":"x.go:1"}')
    assert out == "database is locked"


def test_an_unknown_plain_failure_is_passed_through():
    assert readable_mcp_failure("Segmentation fault (core dumped)") == "Segmentation fault (core dumped)"


def test_silence_is_reported_as_silence():
    out = readable_mcp_failure("")
    assert "said nothing" in out


def test_a_novel_string_is_never_guessed_at():
    out = readable_mcp_failure("could not bind to port 8080")
    assert "sign-in" not in out and "Reconnect" not in out
    assert "port 8080" in out


def test_the_last_line_wins_because_the_fatal_one_comes_last():
    noisy = '{"level":"info","message":"starting up"}\n{"level":"fatal","message":"disk full"}'
    assert readable_mcp_failure(noisy) == "disk full"


def test_output_stays_short_enough_for_a_toast():
    assert len(readable_mcp_failure("x" * 5000)) <= 300
