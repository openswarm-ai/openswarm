import re
from typing import Optional

from typeguard import typechecked

# A bot-detection challenge in the page's own words. We NEVER solve one of these: defeating
# bot-detection is off-limits, and an agent that tries produces exactly the confident nonsense this
# codebase exists to prevent (it cannot hear an audio clip, and "press and hold" against a
# behavioural detector is a coin flip it will report as a success either way).
#
# Named separately from the login wall because the remedy is different. A login wall is fixed by
# signing in once and it stays fixed; a challenge is a one-shot the human has to clear right now,
# in this card, before anything else can proceed.
P_CAPTCHA_RE = re.compile(
    r"enter (?:the )?(?:code|characters) you hear|play the audio|"
    r"press (?:and|&) hold|click and hold|hold to (?:verify|continue)|"
    r"drag (?:the )?(?:slider|puzzle|piece|handle)|slide to (?:verify|complete)|"
    r"i'?m not a robot|verify you are (?:a )?human|are you a human|"
    r"security check|complete the (?:security )?(?:check|challenge)|"
    r"recaptcha|hcaptcha|are you a robot|unusual traffic|"
    r"select all (?:images|squares) (?:with|containing)",
    re.I,
)
# Vendor iframes and containers, for challenges that render no readable copy at all.
P_CAPTCHA_DOM_RE = re.compile(
    r"recaptcha|hcaptcha|turnstile|arkose|funcaptcha|px-captcha|geetest|captcha-?(?:container|frame)",
    re.I,
)


@typechecked
def captcha_kind(state_text: str) -> Optional[str]:
    """Which challenge is on the page, or None.

    The KIND is the whole point of returning a string: "solve the captcha" tells a user nothing,
    while "it wants you to play an audio clip and type what you hear" tells them what they are
    about to do. Measured on tiktok 2026-08-04, where the challenge was an audio one and the run
    burned its whole budget clicking at a page it could never get past.
    """
    text = state_text or ""
    if re.search(r"enter (?:the )?(?:code|characters) you hear|play the audio", text, re.I):
        return "an audio challenge (play the clip and type what you hear)"
    if re.search(r"press (?:and|&) hold|click and hold|hold to (?:verify|continue)", text, re.I):
        return "a press-and-hold challenge"
    if re.search(r"drag (?:the )?(?:slider|puzzle|piece|handle)|slide to (?:verify|complete)", text, re.I):
        return "a slider/puzzle challenge"
    if re.search(r"select all (?:images|squares) (?:with|containing)", text, re.I):
        return "an image-selection challenge"
    if P_CAPTCHA_RE.search(text) or P_CAPTCHA_DOM_RE.search(text):
        return "a bot-detection challenge"
    return None


@typechecked
def prompt_copy(kind: str, host: str) -> tuple[str, str]:
    """(problem, instruction) for the human handoff. Says plainly that we will not attempt it."""
    return (
        f"{host or 'This site'} is showing {kind}.",
        "I can't solve these, and guessing at one would be worse than stopping. Please complete it "
        "in the browser card, then tell me to continue.",
    )
