"""Screenshot pruning: keep first + previous + current, collapse the rest.

Vision images are ~1.3-2k tokens each and the model re-reads every one on every
turn; pruning to 3 anchors (first/previous/current) and stubbing the rest cuts the
re-prefilled image tokens without losing the agent's memory (URL + ReportProgress
text stay). These pin the keep-set, the in-place mutation, and tool_result safety.
"""

from backend.apps.agents.browser.browser_history import (  # p-private-ignore: P_OMITTED_SCREENSHOT_STUB
    prune_old_screenshots,
    P_OMITTED_SCREENSHOT_STUB,
)


def img(tag):
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": tag}}


def shot_turn(tag, url):
    # mirrors _format_tool_result for BrowserScreenshot: [image, text(url)]
    return {"role": "user", "content": [{
        "type": "tool_result", "tool_use_id": f"t_{tag}",
        "content": [img(tag), {"type": "text", "text": f"Screenshot captured. URL: {url}"}],
    }]}


def count_images(messages):
    n = 0
    for m in messages:
        for b in m.get("content", []):
            if isinstance(b, dict):
                if b.get("type") == "image":
                    n += 1
                elif b.get("type") == "tool_result":
                    n += sum(1 for x in b.get("content", []) if isinstance(x, dict) and x.get("type") == "image")
    return n


def test_keeps_first_and_last_two_collapses_middle():
    msgs = [shot_turn(str(i), f"https://site/{i}") for i in range(5)]  # images 0..4
    collapsed = prune_old_screenshots(msgs)
    assert collapsed == 2  # 5 images - (first + last 2) = 2 stubbed
    assert count_images(msgs) == 3
    # image tags that survive are 0 (first), 3 and 4 (last two)
    surviving = [b["source"]["data"] for m in msgs for tr in m["content"]
                 for b in tr["content"] if b.get("type") == "image"]
    assert surviving == ["0", "3", "4"]


def test_three_or_fewer_is_a_noop():
    msgs = [shot_turn(str(i), f"u{i}") for i in range(3)]
    assert prune_old_screenshots(msgs) == 0
    assert count_images(msgs) == 3


def test_stub_preserves_the_url_text_block():
    msgs = [shot_turn(str(i), f"https://site/{i}") for i in range(4)]
    prune_old_screenshots(msgs)
    # the collapsed shot (#1) keeps its "URL:" text, only the image became a stub
    collapsed_tr = msgs[1]["content"][0]["content"]
    assert any(b.get("text") == P_OMITTED_SCREENSHOT_STUB for b in collapsed_tr)
    assert any("URL: https://site/1" in b.get("text", "") for b in collapsed_tr)


def test_handles_direct_image_blocks_too():
    msgs = [
        {"role": "user", "content": [img("a"), {"type": "text", "text": "hi"}]},
        {"role": "user", "content": [img("b")]},
        {"role": "user", "content": [img("c")]},
        {"role": "user", "content": [img("d")]},
    ]
    collapsed = prune_old_screenshots(msgs)
    assert collapsed == 1  # keep a (first), c+d (last two); stub b
    assert msgs[1]["content"][0] == {"type": "text", "text": P_OMITTED_SCREENSHOT_STUB}


def test_keep_recent_is_tunable():
    msgs = [shot_turn(str(i), f"u{i}") for i in range(6)]
    prune_old_screenshots(msgs, keep_first=False, keep_recent=1)
    # only the most recent survives
    assert count_images(msgs) == 1


def tool_use_msg(tu_id, name):
    return {"role": "assistant", "content": [
        {"type": "tool_use", "id": tu_id, "name": name, "input": {}},
    ]}


def tool_result_msg(tu_id, text):
    return {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tu_id,
         "content": [{"type": "text", "text": text}]},
    ]}


def test_prune_stale_page_state_keeps_last_two_attachments():
    from backend.apps.agents.browser.browser_history import (
        PAGE_STATE_MARKER, prune_stale_page_state,
    )
    msgs = []
    for i in range(4):
        msgs.append(tool_use_msg(f"t{i}", "BrowserClickIndex"))
        msgs.append(tool_result_msg(
            f"t{i}", f"Clicked [{i}]\n\n{PAGE_STATE_MARKER}\n[1]<button \"A{i}\">",
        ))
    pruned = prune_stale_page_state(msgs)
    assert pruned == 2
    texts = [m["content"][0]["content"][0]["text"] for m in msgs if m["role"] == "user"]
    assert PAGE_STATE_MARKER not in texts[0] and "Clicked [0]" in texts[0]
    assert PAGE_STATE_MARKER not in texts[1]
    assert PAGE_STATE_MARKER in texts[2] and PAGE_STATE_MARKER in texts[3]
    # idempotent: a second pass finds nothing new to prune
    assert prune_stale_page_state(msgs) == 0


def test_prune_stale_page_state_collapses_old_heavy_reads_only():
    from backend.apps.agents.browser.browser_history import prune_stale_page_state
    big = "28 interactive elements\n" + "\n".join(f"[{i}]<button \"x\">" for i in range(60))
    msgs = []
    for i in range(3):
        msgs.append(tool_use_msg(f"r{i}", "BrowserListInteractives"))
        msgs.append(tool_result_msg(f"r{i}", big))
    msgs.append(tool_use_msg("nav", "BrowserNavigate"))
    msgs.append(tool_result_msg("nav", "Navigated to https://example.com"))
    pruned = prune_stale_page_state(msgs)
    assert pruned == 1
    first = msgs[1]["content"][0]["content"][0]["text"]
    assert first.startswith("28 interactive elements") and "pruned" in first
    assert msgs[3]["content"][0]["content"][0]["text"] == big
    assert msgs[7]["content"][0]["content"][0]["text"] == "Navigated to https://example.com"


# --- incremental cache marker ---------------------------------------------------
def test_cache_marker_places_one_at_depth_and_strips_old():
    from backend.apps.agents.browser.browser_history import place_cache_marker
    msgs = []
    for i in range(12):
        msgs.append(tool_use_msg(f"t{i}", "BrowserClickIndex"))
        msgs.append(tool_result_msg(f"t{i}", f"Clicked [{i}]"))
    place_cache_marker(msgs)
    place_cache_marker(msgs)  # second pass must not accumulate markers
    marked = [
        (mi, b) for mi, m in enumerate(msgs)
        for b in (m["content"] if isinstance(m["content"], list) else [])
        if isinstance(b, dict) and "cache_control" in b
    ]
    assert len(marked) == 1
    assert marked[0][0] == len(msgs) - 8 - 1  # last markable message before the tail zone


def test_cache_marker_skips_short_conversations():
    from backend.apps.agents.browser.browser_history import place_cache_marker
    msgs = [tool_use_msg("t0", "BrowserClickIndex"), tool_result_msg("t0", "Clicked")]
    place_cache_marker(msgs)
    assert all(
        "cache_control" not in b
        for m in msgs for b in m["content"]
        if isinstance(b, dict)
    )


def test_cache_marker_prefix_stays_stable_across_a_simulated_turn():
    from backend.apps.agents.browser.browser_history import (
        PAGE_STATE_MARKER, place_cache_marker, prune_stale_page_state,
    )
    import copy
    import json

    def stripped(ms):
        ms = copy.deepcopy(ms)
        for m in ms:
            for b in (m["content"] if isinstance(m["content"], list) else []):
                if isinstance(b, dict):
                    b.pop("cache_control", None)
        return json.dumps(ms, sort_keys=True)

    msgs = []
    for i in range(10):
        msgs.append(tool_use_msg(f"t{i}", "BrowserClickIndex"))
        msgs.append(tool_result_msg(
            f"t{i}", f"Clicked [{i}]\n\n{PAGE_STATE_MARKER}\n[1]<button \"A{i}\">",
        ))
    prune_stale_page_state(msgs)
    place_cache_marker(msgs)
    cut = len(msgs) - 8
    before = stripped(msgs[:cut])
    # next turn: a new attachment arrives, pruning collapses the one falling out
    msgs.append(tool_use_msg("t10", "BrowserClickIndex"))
    msgs.append(tool_result_msg(
        "t10", f"Clicked [10]\n\n{PAGE_STATE_MARKER}\n[1]<button \"A10\">",
    ))
    prune_stale_page_state(msgs)
    place_cache_marker(msgs)
    assert stripped(msgs[:cut]) == before
