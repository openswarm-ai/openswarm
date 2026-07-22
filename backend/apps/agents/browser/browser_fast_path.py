"""
Browser fast path: skip the orchestrator for plainly browser-only requests.

The orchestrator LLM is ~2/3 of the token bill on a single-browser task and
adds two model turns of latency, all to decide "delegate this to a browser
agent" and then restate the agent's own outcome. When the request is clearly
just browsing, dispatch the browser sub-agent directly and let its Done
message (a clean human reply already) be the reply.

Three gates, all conservative; any miss falls through to the orchestrator:
1. eligibility: first message of an agent session on a dashboard, no
   attachments/images/skills/forced tools (those need the orchestrator).
2. a zero-cost wordlist prefilter, so non-browsy chats never pay the
   classifier's latency.
3. a cheap-tier aux YES/NO classifier (provider-agnostic, timeboxed); only
   an unambiguous YES takes the fast path.
"""

import asyncio
import logging
import re
import time

logger = logging.getLogger(__name__)

# Zero-cost smell test: only prompts that mention the web at all are worth a classifier call. False negatives just take the normal path.
P_BROWSY_RE = re.compile(
    r"https?://|www\.|\b[a-z0-9-]+\.(com|org|net|io|co|ai|dev|app)\b"
    r"|\b(browse|browser|website|web ?page|webpage|site|url|tab)\b"
    r"|\b(go to|open|visit|navigate|log ?in|sign ?in|search on|look up on|check on)\b"
    r"|\b(linkedin|twitter|x\.com|facebook|instagram|reddit|youtube|amazon|gmail|github"
    r"|google|wikipedia|hacker ?news|tiktok|tinder|slack|notion|ebay|etsy|zillow|airbnb)\b",
    re.I,
)

P_CLASSIFIER_SYSTEM = (
    "You route requests to a web-browsing agent. It drives a real signed-in browser: "
    "navigating sites, reading or extracting or counting what is on pages, clicking, "
    "typing, and acting inside web apps (sending messages on LinkedIn or any site, "
    "posting, ordering, booking, filling forms).\n"
    "When a website or web app is the context, 'text/message/DM someone' means "
    "sending the message inside that site, which is browsing. Treat 'text' as SMS "
    "only when a phone number is given or no site is involved.\n"
    "Line 1 of your reply is exactly one word: READ, ACT, or NO.\n"
    "READ: the request only needs information from a PUBLIC page, no sign-in, no "
    "account-specific data ('my' anything), and nothing on the page changes.\n"
    "ACT: browsing completes it but it involves signing in, account data, "
    "changing state (sending, posting, filling, booking, buying, opening the "
    "user's own messages/feed), or the user wants a page left open on their "
    "screen as the goal ('open X', 'pull up X', 'show me X'). When torn "
    "between READ and ACT, say ACT.\n"
    "NO: any part clearly needs something a browser cannot do: local files or "
    "folders, writing or running code, a terminal, creating documents or "
    "spreadsheets, SMS to a phone number, or other desktop apps. Also NO for "
    "plain conversation or questions answerable without visiting any site.\n"
    "Examples:\n"
    "'go to maya's linkedin and text her thanks' -> ACT\n"
    "'open hacker news and tell me the top story' -> READ (the answer is the "
    "goal, not the open page)\n"
    "'search wikipedia for tardigrades and open the article' -> ACT\n"
    "'count the messages in my linkedin thread with bob' -> ACT\n"
    "'find the report on stripe.com and save it to my desktop' -> NO\n"
    "'text 555-0102 that I'm late' -> NO\n"
    "If line 1 is NO, reply with exactly the word NO and nothing else.\n"
    "If line 1 is READ or ACT, follow it with a short browsing brief:\n"
    "ENTRY: the best starting URL; use a direct deep/search URL when the site's "
    "pattern is well known (LinkedIn people search is "
    "https://www.linkedin.com/search/results/people/?keywords=NAME). Always a normal "
    "page a person would see, never a raw JSON/API endpoint (e.g. Instagram's "
    "web/search/topsearch), which renders as an unreadable data wall.\n"
    "Then 3-6 numbered steps, one short action each.\n"
    "Copy any text the user wants typed, sent, or posted EXACTLY, character for "
    "character. Never invent names, values, or wording the user did not give."
)


def fast_path_eligible(
    prompt: str,
    mode: str,
    dashboard_id: str | None,
    is_first_message: bool,
    has_attachments: bool,
) -> bool:
    """Pure gate: cheap, no I/O. Follow-ups are excluded because the sub-agent
    only receives the prompt text; the orchestrator carries the history a
    follow-up usually leans on."""
    if mode != "agent" or not dashboard_id or not is_first_message or has_attachments:
        return False
    if not prompt or not prompt.strip():
        return False
    return bool(P_BROWSY_RE.search(prompt))


def parse_verdict_and_brief(text: str) -> tuple[str, str]:
    """Line 1 carries READ/ACT/NO; the rest is the routing brief. Anything
    unparseable is 'no' (normal path)."""
    lines = (text or "").strip().splitlines()
    head = lines[0].strip().upper() if lines else ""
    if head.startswith("READ"):
        verdict = "read"
    elif head.startswith("ACT") or head.startswith("YES"):
        verdict = "act"
    else:
        return "no", ""
    brief = "\n".join(line for line in lines[1:] if line.strip()).strip()
    return verdict, brief[:700]


P_ENTRY_RE = re.compile(r"^\s*ENTRY:\s*(https?://\S+)", re.I | re.M)


def entry_url_from_brief(brief: str) -> str:
    """The brief's ENTRY deep URL, or ''. Powers dispatch pre-navigation: a NEW
    card opens directly on it instead of google, killing the orient+navigate
    turns; a REUSED card is never moved (its deeper live state wins)."""
    m = P_ENTRY_RE.search(brief or "")
    return m.group(1).rstrip(".,;)") if m else ""


# Opens the advisory-brief section of a composed task; consumers strip everything after it when a
# check must apply only to the human's words (the brief once false-flagged a real send read-only).
BRIEF_MARKER = "[routing brief"


def compose_task(prompt: str, brief: str) -> str:
    """User's words first and authoritative; the brief is advisory routing.
    Skill replay keys on the parent's user message, so brief variance is safe."""
    if not brief:
        return prompt
    return (
        f"{prompt}\n\n"
        f"{BRIEF_MARKER} from a fast pre-pass; follow it unless the live page disagrees]\n"
        f"{brief}"
    )


def dispatch_failed(result: dict) -> bool:
    """Fail-closed: a real completion sets done=True (the sub-agent called Done
    with success, and the honesty gate agreed). Anything else, a hung/errored
    dispatch or the model reporting it couldn't, means recovery should run. The
    recovery task's verify-first wording makes a rare redundant retry safe."""
    return not (isinstance(result, dict) and result.get("done", False))


NO_DASHBOARD_REPLY = (
    "I can't drive a browser right now because no OpenSwarm window is connected. "
    "Open the app window and send this again."
)


def recovery_task(prompt: str, first_report: str, verified_undelivered: bool = False) -> str:
    """One informed retry, replacing the orchestrator's recovery role. With
    verified_undelivered the send-probe already proved nothing landed, so the
    retry gets clearance instead of hedging; otherwise verify-first wording
    keeps a maybe-already-sent irreversible step from repeating."""
    report = (first_report or "").strip()[:600] or "no report (the browser died)"
    guard = (
        "A read-only check JUST confirmed the message is NOT yet delivered, so "
        "performing the send is safe. Do it exactly ONCE, solo, with `expect` proof."
    ) if verified_undelivered else (
        "If that attempt may have already performed an irreversible step "
        "(send/submit/post/pay), FIRST verify on the page whether it happened; "
        "if it did, do NOT repeat it, report DONE with that proof."
    )
    return (
        "A previous browser attempt at this task did not finish. It reported:\n"
        f"{report}\n\n"
        f"Finish the task: {prompt}\n\n{guard}"
    )


def send_probe_task(prompt: str, payload: str) -> str:
    """Recovery pre-check for send-class failures: a read-only dispatch whose
    verdict gates the retry in code (r44's retry skipped its promised verify
    step, so prose alone is not a guard)."""
    return (
        "READ-ONLY verification, do NOT send, type, click any send/submit "
        "control, or open a compose box. A previous attempt at the task below "
        f"may or may not have already delivered its message:\n{prompt}\n\n"
        "Check the relevant conversation/thread/history for this exact text:\n"
        f'"{payload}"\n'
        "Count near-variants too (extra whitespace, duplicated text). "
        "End with exactly one line: 'OUTCOME: PAYLOAD-FOUND <where and timestamp>' "
        "or 'OUTCOME: PAYLOAD-NOT-FOUND'."
    )


def probe_verdict(summary: str) -> str:
    """'found' | 'not-found' | 'unknown'. NOT-FOUND is checked first because
    the FOUND token is its substring."""
    s = (summary or "").upper()
    if "PAYLOAD-NOT-FOUND" in s:
        return "not-found"
    if "PAYLOAD-FOUND" in s:
        return "found"
    return "unknown"


def already_sent_reply(payload: str, probe_report: str) -> str:
    """First attempt delivered before dying; the fix is evidence, not a resend."""
    proof = (probe_report or "").strip()[:400]
    return (
        "The first attempt actually delivered the message before it lost the "
        f'browser: a read-only check found "{payload}" already in the '
        f"conversation, so I did NOT send it again.\n\n{proof}"
    )


def unverifiable_reply(payload: str, first_report: str) -> str:
    """Fail-closed: can't prove the send didn't land, so don't risk a double."""
    report = (first_report or "").strip()[:400]
    return (
        "The browser attempt failed after it had already typed the message "
        f'("{payload}"), and a read-only check could not confirm whether it was '
        "sent. I'm not retrying an irreversible send blind; please glance at "
        f"the thread and re-ask if it's missing.\n\nFirst attempt: {report}"
    )


def normalize_for_classifier(prompt: str) -> str:
    """Haiku reads bare 'text him' as SMS even with a site as context. In the
    browsy-prefiltered pool, text-with-no-phone-number is in-site messaging,
    so spell it out for the small model. Only the classifier sees this."""
    if re.search(r"\d{7,}", prompt):
        return prompt
    return re.sub(r"\btext(ing|ed|s)?\b", "message", prompt, flags=re.I)


def seed_hints_for_task(prompt: str) -> str:
    """Documented facts for sites the task names, fed to the classifier so its ENTRY
    uses the site's real search-URL pattern instead of the homepage (measured: the aux
    sent walmart to the homepage while the seed had the exact /search?q= pattern)."""
    from backend.apps.agents.browser.seed_playbooks import SEED_PLAYBOOKS
    low = f" {prompt.lower()} "
    lines: list[str] = []
    for domain, facts in SEED_PLAYBOOKS.items():
        name = domain.split(".")[0]
        if len(name) >= 4 and f" {name}" in low and facts:
            lines.append(f"{domain}: {facts[0][:180]}")
            if len(lines) >= 2:
                break
    return ("\n\nKnown site facts (use their URL patterns for ENTRY):\n" + "\n".join(lines)) if lines else ""


async def classify_and_brief(prompt: str, settings, primary_api: str | None) -> tuple[str, str]:
    """One cheap aux call returns a READ/ACT/NO verdict plus a routing brief
    (entry URL + step outline), timeboxed; any failure means NO (normal path)."""
    t0 = time.monotonic()
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model

        aux_model, _ = await resolve_aux_model(
            settings, preferred_tier="haiku", primary_api=primary_api,
        )
        client = get_anthropic_client_for_model(settings, aux_model)
        resp = await asyncio.wait_for(
            client.messages.create(
                model=aux_model,
                max_tokens=250,
                temperature=0,
                system=P_CLASSIFIER_SYSTEM,
                messages=[{"role": "user", "content": (
                    normalize_for_classifier(prompt[:2000]) + seed_hints_for_task(prompt))}],
            ),
            timeout=8.0,
        )
        from backend.apps.agents.core.aux_llm import safe_resp_text
        verdict, brief = parse_verdict_and_brief(safe_resp_text(resp))
        logger.info(
            f"[browser-fast-path] classifier: {verdict.upper()} brief={len(brief)}ch "
            f"model={aux_model} in {int((time.monotonic() - t0) * 1000)}ms"
        )
        return verdict, brief
    except Exception as e:
        logger.warning(f"[browser-fast-path] classifier unavailable, normal path: {e}")
        return "no", ""
