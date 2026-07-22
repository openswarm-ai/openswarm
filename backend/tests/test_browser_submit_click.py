"""Container-scoped submit tier: the middle rung between the below-composer index pick and the
by-name 'Send' last resort, plus the expression builder's escaping. The JS itself is proven live
(X modal resolves tweetButton, inline resolves tweetButtonInline at hop 20); these tests pin the
tier ORDER and the fail-safe parse."""
import pytest

from backend.apps.agents.browser import browser_send_script as ss
from backend.apps.agents.browser import browser_submit_click as sc
from backend.apps.agents.browser.browser_agent import send_submit_index_in_state

# Committed fill whose submit ranks OUT of the capped listing (the shape that starves the picker).
COMPOSER_FILLED_NO_SEND = '[1]<textbox "I\'m looking for…">\n[24]<textbox "Write a message" value="[test] hello world r9-os">'
COMPOSER_SENT = '[2]<textbox "Write a message">\n[9]<button "Attach">'


def make_exec(eval_result):
    calls = {"clicks": []}

    async def execute(tool, params, bid, tid):
        if tool == "BrowserListInteractives":
            return {"text": COMPOSER_SENT}
        calls["clicks"].append((tool, params))
        if tool == "BrowserEvaluate":
            return eval_result
        return {"ok": True}
    return execute, calls


@pytest.mark.asyncio
async def test_container_submit_tier_between_index_and_by_name():
    """X's compose modal: covered feed rows behind the overlay eat the 60-row cap, so the modal's
    own Post never reaches the picker (live 0/2 deliveries). The container tier resolves the
    submit inside the composer's own container and clicks it with REAL input; by-name stays last."""
    execute, calls = make_exec({"value": {"ok": True, "name": "post", "xPct": 61.0, "yPct": 33.0}})
    r = await ss.complete_send("[test] hello world r9-os", COMPOSER_FILLED_NO_SEND,
                               "b1", "", execute, send_submit_index_in_state, composer_index=24)
    assert r["clicked"] is True and r["sent"] is True
    tools = [c[0] for c in calls["clicks"]]
    assert "BrowserEvaluate" in tools and "BrowserClickByName" not in tools
    point = [c for c in calls["clicks"] if c[0] == "BrowserClickPoint"]
    assert point and point[0][1] == {"xPercent": 61.0, "yPercent": 33.0}


@pytest.mark.asyncio
async def test_container_submit_miss_falls_to_by_name():
    execute, calls = make_exec({"value": {"ok": False, "why": "no submit control in the composer container"}})
    r = await ss.complete_send("[test] hello world r9-os", COMPOSER_FILLED_NO_SEND,
                               "b1", "", execute, send_submit_index_in_state, composer_index=24)
    assert r["clicked"] is True
    tools = [c[0] for c in calls["clicks"]]
    assert tools.index("BrowserEvaluate") < tools.index("BrowserClickByName")


def test_container_submit_expression_escapes_and_truncates():
    expr = sc.container_submit_expression('he said "hi" ' + "x" * 60)
    assert '\\"hi\\"' in expr        # payload lands as a JS string literal, quotes escaped
    assert "x" * 30 not in expr      # truncated to the 24-char prefix the fill verifier uses
    assert '"post"' in expr and '"send"' in expr


def test_parse_eval_value_reads_value_text_and_garbage():
    assert sc.parse_eval_value({"value": {"ok": True}}) == {"ok": True}
    assert sc.parse_eval_value({"text": '{"ok": false, "why": "x"}'}) == {"ok": False, "why": "x"}
    assert sc.parse_eval_value({"text": "not json"}) is None
    assert sc.parse_eval_value({"error": "boom"}) is None
    assert sc.parse_eval_value("weird") is None
