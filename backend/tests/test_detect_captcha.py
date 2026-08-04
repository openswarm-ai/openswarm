"""Bot-detection challenges are handed to the user, never attempted.

Eric screenshotted the case on 2026-08-04: TikTok showing "Play the audio and enter the code you
hear" over a logged-out feed, while the run underneath burned its budget clicking at a page it could
never get past. These come in several shapes (audio, press-and-hold, slider/puzzle, image grid) and
they share one property: an agent cannot honestly clear any of them. It cannot hear the clip, and a
press-and-hold against a behavioural detector is a coin flip that reports success either way, which
is precisely the false-success class the rest of this suite exists to prevent.

So the rule is refuse and escalate. What these tests protect is (a) that the common shapes are
detected at all, and (b) that ordinary pages are NOT, because a detector that cries captcha on a
checkout form interrupts the user for nothing.
"""

from backend.apps.agents.browser import detect_captcha as dc


def test_the_tiktok_audio_challenge_from_the_screenshot():
    kind = dc.captcha_kind("Play the audio and enter the code you hear")
    assert kind and "audio" in kind, kind


def test_the_interaction_shaped_challenges_are_each_named():
    """The kind is load-bearing: "solve the captcha" tells a user nothing, "it wants you to play a
    clip and type what you hear" tells them what they are about to do."""
    assert "press-and-hold" in (dc.captcha_kind('[3]<button "Press and Hold">') or "")
    assert "slider" in (dc.captcha_kind("Drag the slider to complete the puzzle") or "")
    assert "image-selection" in (dc.captcha_kind("Select all images with traffic lights") or "")


def test_a_vendor_frame_counts_even_with_no_readable_copy():
    """Some challenges render nothing a human would call a sentence."""
    for frame in ("https://www.google.com/recaptcha/api2/anchor",
                  "hcaptcha-checkbox", "cf-turnstile", "arkose-frame", "geetest_panel"):
        assert dc.captcha_kind(frame), frame


def test_an_ordinary_page_is_not_a_challenge():
    """The expensive direction. Every false positive is an interruption the user did not need, and
    the words overlap with innocent copy: a discount CODE, a verification email, a security page."""
    for page in (
        '[1]<textbox "Add a comment...">\n[2]<button "Post">',
        "Enter your discount code at checkout",
        "We sent a verification email to your inbox",
        '[4]<link "Security settings">',
        '[2]<textbox "Search">\n[9]<button "Log in">',
    ):
        assert dc.captcha_kind(page) is None, page


def test_the_handoff_copy_says_plainly_that_we_will_not_try():
    """A user reading this must not be left thinking the agent might have another go."""
    problem, instruction = dc.prompt_copy("an audio challenge", "tiktok.com")
    assert "tiktok.com" in problem
    assert "can't solve" in instruction
    assert "complete it" in instruction.lower()
