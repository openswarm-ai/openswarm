"""A stale element index must be retried; every other failure must not.

Measured live on x.com 2026-07-28, with the send-script correctly armed and having already found
opener 'Post' and target 'Post text':

    [browser-sendscript] fill errored (Index 53 is not in the cached element map.
     Call BrowserListInteractives first to refresh the index, then try again.)

The compose modal keeps re-rendering after we list it, so the composer node is detached by the time
the fill lands. The script then surrendered a send it had already located and handed the whole task
back to the model, which is most of the gap between a ~19s scripted write and a ~56s modelled one.

The discrimination is the safety-critical part. A stale index means the control WAS there and the
page moved underneath us, so re-listing and retrying is correct and cannot duplicate anything (the
fill has not committed). A genuine miss (no such control, refused input, a dead card) must never
retry, because retrying a real failure on a write path is how you post twice.
"""
from backend.apps.agents.browser import browser_submit_click as sc

STALE = [
    {"error": "Index 53 is not in the cached element map. Call BrowserListInteractives first to "
              "refresh the index, then try again."},
    {"error": "Index 7 is not in the cached element map."},
    {"error": "Stale index; refresh the index and retry"},
    {"error": "NOT IN THE CACHED ELEMENT MAP"},
]

# Real failures. Retrying any of these is either useless or dangerous.
NOT_STALE = [
    {"error": "No element found matching that selector"},
    {"error": "Element is not visible"},
    {"error": "Navigation timed out"},
    {"error": "Target closed"},
    {"error": "browser card is gone"},
    {"error": ""},
    {},
    {"text": "ok"},
]


def test_a_stale_index_is_recognised():
    missed = [r for r in STALE if not sc.is_stale_index_error(r)]
    assert not missed, f"these stale-index errors would not be retried: {missed}"


def test_the_exact_string_measured_live_is_recognised():
    assert sc.is_stale_index_error({"error": (
        "Index 53 is not in the cached element map. Call BrowserListInteractives first to refresh "
        "the index, then try again.")})


def test_real_failures_are_never_retried():
    """The dangerous direction: a retry on a genuine failure is how a write path double-posts."""
    wrong = [r for r in NOT_STALE if sc.is_stale_index_error(r)]
    assert not wrong, f"these would be wrongly retried: {wrong}"


def test_non_dict_results_are_not_stale():
    for junk in (None, "boom", 42, [], object()):
        assert sc.is_stale_index_error(junk) is False


def test_a_success_is_not_a_stale_error():
    assert not sc.is_stale_index_error({"value": {"ok": True}})


def test_the_matcher_is_anchored_on_the_stable_half_of_the_sentence():
    """Anchoring on the whole sentence would let a reworded tail silently disable the retry, taking
    the fast write path down with it and looking like a performance regression, not a bug."""
    assert sc.is_stale_index_error({"error": "index 12 is not in the cached element map (v2)"})
    assert sc.is_stale_index_error({"error": "please refresh the index"})


def test_the_send_script_actually_calls_it():
    """A predicate nothing consults is decoration. Guards against the retry being dropped while
    these tests keep passing."""
    src = sc.__file__.replace("browser_submit_click.py", "browser_send_script.py")
    with open(src) as f:
        text = f.read()
    assert "is_stale_index_error(" in text
    assert "retrying the fill once" in text


def test_the_retry_is_bounded_to_one_attempt():
    """Two fills is a refresh; a loop is a way to hammer a site that is refusing input."""
    src = sc.__file__.replace("browser_submit_click.py", "browser_send_script.py")
    with open(src) as f:
        body = f.read()
    seg = body[body.index("stale composer index") - 1200: body.index("stale composer index") + 1200]
    assert "for " not in seg.split("stale composer index")[1][:600], "the retry must not be a loop"
