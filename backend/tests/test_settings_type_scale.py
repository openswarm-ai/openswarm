"""Settings type has to stay on the shared scale.

Measured 2026-07-27: the Settings area carried 17 distinct hardcoded rem sizes, including 0.72,
0.74, 0.75 and 0.78 in the same screen. Nobody chose those four; they are drift, and drift is what
makes a UI read as unfinished no matter how good any single page is. claudeTokens already defines
the scale and its own comment says to use `c.font.size.*` instead of a raw rem string, so this is a
standard the code had rather than a new opinion.

The guard is here rather than in eslint because this suite is what actually runs on every change.
"""
import os
import re

P_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P_SETTINGS = os.path.join(P_REPO_ROOT, "frontend", "src", "app", "pages", "Settings")
P_TOKENS = os.path.join(P_REPO_ROOT, "frontend", "src", "shared", "styles", "claudeTokens.ts")

P_RAW_SIZE_RE = re.compile(r"fontSize: '[0-9.]+rem'")


def p_settings_files():
    for dirpath, dirs, files in os.walk(P_SETTINGS):
        for fn in sorted(files):
            if fn.endswith((".tsx", ".ts")):
                yield os.path.join(dirpath, fn)


def test_the_scale_exists_to_snap_to():
    """If the scale is ever removed, the rule below becomes unfollowable and this says so first."""
    with open(P_TOKENS, encoding="utf-8") as fh:
        src = fh.read()
    assert "export const fontSize: FontSizeScale" in src
    assert "size: fontSize," in src, "the scale must be wired into the token objects, not just declared"


def test_no_hardcoded_rem_font_sizes_in_settings():
    """Every size goes through c.font.size.*, so a new page inherits the scale instead of guessing."""
    offenders = []
    for path in p_settings_files():
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if P_RAW_SIZE_RE.search(line):
                    offenders.append(f"{os.path.relpath(path, P_REPO_ROOT)}:{i}: {line.strip()}")
    assert not offenders, (
        "hardcoded rem font sizes are back in Settings; use c.font.size.* instead:\n  "
        + "\n  ".join(offenders))


def test_settings_uses_a_small_number_of_steps():
    """A scale only buys anything if the page actually restrains itself to a few steps. Nine exist;
    one screen reaching for most of them is the same noise problem wearing a nicer name."""
    used = set()
    for path in p_settings_files():
        with open(path, encoding="utf-8") as fh:
            used.update(re.findall(r"c\.font\.size\.([a-z]+)", fh.read()))
    assert used, "Settings should reference the scale at all"
    assert len(used) <= 7, f"Settings spreads across too many type steps: {sorted(used)}"
