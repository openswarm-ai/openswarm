"""Every piece of prompt copy that advertises RequestHumanIntervention, plus the scrubber that
removes all of it for runs where no human exists (workflow runs, or the tool switched off).

The named constants are spliced into SYSTEM_PROMPT / the loop nudges at their definition sites, so
strip_intervention_copy's exact replaces cannot drift apart from the live copy; a test asserts the
scrubbed output never names the tool, which also catches copy born anywhere else (seed playbooks,
learned playbooks, aux adjudication advice) via the catch-all.
"""

from typeguard import typechecked

# Passkeys structurally cannot work here: macOS only exposes Touch ID / iCloud Keychain passkeys to
# browsers carrying Apple's restricted web-browser entitlement, which this app does not have, so the
# ceremony always dies as Google's generic "Something went wrong" (ENG-269, measured: uvpaa=false).
PASSKEY_LINE = (
    "- Passkey sign-in (Touch ID / iCloud Keychain) does NOT work in this browser and shows "
    "\"Something went wrong\"; click \"Try another way\" and use the password path instead of retrying.\n"
)

INTERVENTION_SECTION = (
    "## When you genuinely cannot proceed\n"
    "Use RequestHumanIntervention for:\n"
    "- Login walls (the user thinks they're logged in but the session expired)\n"
    "- Captchas, 2FA prompts, age verification gates\n"
    "- Anything genuinely ambiguous about user intent\n"
    + PASSKEY_LINE +
    "Don't use it for normal tool failures; try a different approach first.\n\n"
)

NO_INTERVENTION_SECTION = (
    "## When you genuinely cannot proceed\n"
    "No human is available in this run. If a login wall, captcha, or 2FA gate blocks every "
    "route, stop and call Done with success=false, naming exactly what blocked you.\n"
    + PASSKEY_LINE + "\n"
)

LOOP_AWARENESS_INTERVENTION_PHRASE = (
    ", or call RequestHumanIntervention if you genuinely cannot proceed"
)

LOOP_WARNING_INTERVENTION_FIX = (
    "a login, captcha, or error page means call RequestHumanIntervention"
)
LOOP_WARNING_NO_INTERVENTION_FIX = (
    "a login, captcha, or error page you cannot route around means the task is blocked, "
    "so call Done with success=false and name the wall"
)

STAGNATION_INTERVENTION_TAIL = (
    "If even a fresh plan can't make progress, call RequestHumanIntervention instead of "
    "continuing to fail."
)
STAGNATION_NO_INTERVENTION_TAIL = (
    "If even a fresh plan can't make progress, call Done with success=false and report "
    "exactly what is blocking you."
)


@typechecked
def strip_intervention_copy(text: str) -> str:
    out = text.replace(INTERVENTION_SECTION, NO_INTERVENTION_SECTION)
    out = out.replace(LOOP_AWARENESS_INTERVENTION_PHRASE, "")
    out = out.replace(LOOP_WARNING_INTERVENTION_FIX, LOOP_WARNING_NO_INTERVENTION_FIX)
    out = out.replace(STAGNATION_INTERVENTION_TAIL, STAGNATION_NO_INTERVENTION_TAIL)
    out = out.replace(
        "use RequestHumanIntervention",
        "stop and call Done with success=false naming the wall",
    )
    # Catch-all: no string reaching the model may name a tool it does not have.
    out = out.replace("RequestHumanIntervention", "Done with success=false")
    return out
