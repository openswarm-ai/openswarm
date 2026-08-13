"""A completion claim must be backed by evidence appropriate to what the task asked for (ENG-297).

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_browser_completion_honesty.py -v
"""

from backend.apps.agents.browser.browser_loop import (
    completion_is_honest,
    is_mutation_task,
    summary_fabricates_tool_calls,
)


def p_ok(tool, summary=""):
    return {"tool": tool, "ok": True, "result_summary": summary}


# --- ENG-297: a read-only run may not satisfy a task that demanded a change. ---
#
# Measured 2026-08-13, 6 dispatches at a Monaco editor (Google Apps Script), task "delete two name
# references and redeploy". Dispatch 5 returned "Task completed." on 3 read-only calls and zero
# edits; dispatch 2 returned instructions to open devtools by hand, also on 2 read-only calls. Both
# passed the honesty gate, because `completion_is_honest` accepts ANY successful read as evidence
# once the run took no productive action. That is right for "what is on this page" and wrong for
# "change this page", and the gate had no way to tell them apart.
#
# The caller then relayed a fabricated result to the user as a security incident. So the cost of
# this hole is not a wasted run, it is a lie with our name on it.


def test_a_mutation_task_is_recognised_as_one():
    for task in [
        "delete the two name references from the script and redeploy it",
        "edit line 3 and save",
        "rename the project",
        "remove that comment",
    ]:
        assert is_mutation_task(task), f"not recognised as a change: {task!r}"


def test_an_informational_ask_is_not_a_mutation_task():
    # The cry-wolf direction. These verbs appear in read-only asks constantly, and a false positive
    # here turns a correct read into a reported failure, which is worse than the bug being fixed.
    for task in [
        "what does the delete button say",
        "is there an edit option on this page",
        "read the first comment",
        "find the save button and tell me where it is",
    ]:
        assert not is_mutation_task(task), f"an informational ask scored as a change: {task!r}"


def test_reads_alone_cannot_complete_a_mutation_task():
    """The exact dispatch-5 ghost: 3 successful reads, zero edits, 'Task completed.'"""
    log = [
        p_ok("BrowserGetText", "function doPost() {"),
        p_ok("BrowserListInteractives", "12 buttons"),
        p_ok("BrowserScreenshot", "captured"),
    ]
    honest, reason = completion_is_honest(log, mutation_task=True)
    assert not honest, "a run that changed nothing was allowed to claim it completed a change"
    assert "no state-changing action" in reason, reason


def test_the_same_log_is_still_honest_for_a_read_only_task():
    """Both directions: the fix must not turn every look-only run into a failure."""
    log = [
        p_ok("BrowserGetText", "function doPost() {"),
        p_ok("BrowserListInteractives", "12 buttons"),
    ]
    honest, reason = completion_is_honest(log, mutation_task=False)
    assert honest and reason == "", reason


def test_a_real_edit_via_browserevaluate_still_completes():
    """Dispatch 1 did the work with BrowserEvaluate ~12 times. Flagging it would be the false
    positive that makes the gate untrustworthy, so an Evaluate counts as a change on a change task."""
    log = [
        p_ok("BrowserGetText", "function doPost() {"),
        p_ok("BrowserEvaluate", "editor.setValue applied"),
    ]
    honest, reason = completion_is_honest(log, mutation_task=True)
    assert honest and reason == "", reason


# --- Gate 3 (ENG-297): tool-call markup in the SUMMARY is narration, not a tool call. ---
#
# Dispatch 3 printed literal <invoke name="BrowserEvaluate"> markup as TEXT, complete with
# plausible return values for lines 1/2/3 of the file, on an action log of 2 read-only calls. The
# caller read that as real output, believed a line-1 prompt injection that did not exist, and
# escalated it to the user as a security incident. This is the failure that produced an actual lie,
# so the markup must fail the run rather than reach anyone as content.


def test_fabricated_tool_call_markup_is_caught():
    for text in [
        'I ran <invoke name="BrowserEvaluate">{"script":"..."}</invoke> and got line 1',
        "here is the call: <invoke name=\"BrowserGetText\">",
        "<function_calls>\n<invoke name=\"BrowserClick\">",
    ]:
        assert summary_fabricates_tool_calls(text), f"fabricated markup passed through: {text[:50]!r}"


def test_ordinary_prose_about_tools_is_not_caught():
    """Cry-wolf direction: agents legitimately NAME tools in prose, and failing those would make
    every honest summary a failure."""
    for text in [
        "I used BrowserEvaluate to read the buffer, then saved.",
        "BrowserClick failed twice so I fell back to BrowserClickIndex.",
        "The page has an <input> and a <button> element.",
        "",
    ]:
        assert not summary_fabricates_tool_calls(text), f"honest prose flagged: {text[:50]!r}"


def test_a_fabricating_run_cannot_report_completed():
    log = [p_ok("BrowserGetText", "function doPost() {"), p_ok("BrowserScreenshot", "captured")]
    honest, reason = completion_is_honest(
        log, summary='<invoke name="BrowserEvaluate">{"script":"editor.getValue()"}</invoke>')
    assert not honest, "a summary that faked tool calls was reported as a completion"
    assert "fabricat" in reason.lower(), reason
