"""A wedged APP preview is remounted, never evicted, and never left stuck.

ENG-402 item 4, production 1.7.9. An agent finished editing an app, tried to verify its own change
in the preview, and got "the browser became unresponsive" three times running -- "not a transient
blip on their end, something in that specific preview session is stuck".

`evict_dead_card` resolves the card from `layout.browser_cards`. An app preview's id is
`app:<output_id>` and it lives in `view_cards`, so the lookup misses, the function returns early,
and NOTHING is ever torn down. The only remaining remedy was `DEAD_CARDS`, a same-host reuse skip,
which is meaningless for an app because the card IS the app.
"""

SRC = "backend/apps/agents/browser/browser_agent.py"
WS = "frontend/src/shared/ws/WebSocketManager.ts"
SLICE = "frontend/src/shared/state/outputsSlice.ts"
CARD = "frontend/src/app/pages/Dashboard/cards/DashboardViewCard.tsx"


def p_src() -> str:
    return open(SRC).read()


def test_an_app_card_takes_the_remount_path_not_the_evict_path():
    src = p_src()
    i = src.index("await remount_app_card(dashboard_id, browser_id)")
    branch = src[src.rindex("if browser_id.startswith", 0, i):i]
    assert "DEAD_CARDS.add" not in branch, "a reuse-skip cannot heal a card that has no alternative"


def test_a_browser_card_keeps_its_existing_eviction():
    """The control: this must not change the browser path, which evict-and-respawn heals correctly."""
    src = p_src()
    i = src.index("await remount_app_card(dashboard_id, browser_id)")
    tail = src[i:i + 1400]
    assert "elif os.environ.get(\"OSW_DEADCARD_EVICT\"" in tail
    assert "evict_dead_card(dashboard_id, browser_id)" in tail


def test_the_remount_never_deletes_anything():
    """The whole reason this is not eviction: that card is the user's app. Deleting it would be far
    worse than the wedge it heals."""
    src = p_src()
    i = src.index("async def remount_app_card")
    body = src[i:src.index("async def evict_dead_card")]
    # Check for CALLS, not for the word: the docstring says "never deletes anything".
    code = "\n".join(ln.split("#")[0] for ln in body.splitlines() if not ln.strip().startswith(('"""', "'")))
    for destructive in ("delete_", ".pop(", "remove", "browser_card_evict", "DEAD_CARDS"):
        assert destructive not in code, f"remount must not call {destructive}"
    assert "broadcast_global(\"dashboard:app_card_remount\"" in body


def test_the_output_id_is_parsed_out_of_the_card_id():
    """`app:<output_id>` and `app:<output_id>#<instance>` must both resolve to the output."""
    src = p_src()
    i = src.index("async def remount_app_card")
    body = src[i:i + 900]
    # Reuses the module's existing parser rather than adding a second one; that parser now strips
    # the `#<instance>` suffix, which it did not before.
    assert "app_output_id(browser_id)" in body
    assert "if not p_output_id:" in body, "a malformed id must not broadcast an empty target"


def test_a_failed_broadcast_cannot_break_the_abort_path():
    src = p_src()
    i = src.index("async def remount_app_card")
    body = src[i:src.index("async def evict_dead_card")]
    assert "except Exception:" in body


def test_the_renderer_actually_remounts_rather_than_soft_reloading():
    """A hung renderer never processes a `.reload()` IPC; only a fresh element helps."""
    ws = open(WS).read()
    assert "dashboard:app_card_remount" in ws
    assert "remountAppPreview(" in ws
    card = open(CARD).read()
    i = card.index("<ViewPreview\n")
    props = card[i:i + 500]
    assert "key={" in props and "remountSignal" in props, \
        "the key is what forces React to build a new webview"


def test_the_signal_is_per_app():
    slice_src = open(SLICE).read()
    assert "remountSignal: Record<string, number>;" in slice_src
    i = slice_src.index("remountAppPreview(state")
    assert "(state.remountSignal[id] ?? 0) + 1" in slice_src[i:i + 260]


def test_the_shared_parser_handles_an_instance_suffix():
    """`app:<id>#2` is how DashboardViewCard addresses a second instance; a caller that forgot the
    suffix would broadcast a target no card matches, and the wedge would look unfixed."""
    from backend.apps.agents.browser.browser_agent import app_output_id
    assert app_output_id("app:abc123") == "abc123"
    assert app_output_id("app:abc123#2") == "abc123"
    assert app_output_id("b-77") is None
    assert app_output_id("app:") is None
