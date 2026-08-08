"""A paste that is not a skills install must return None, not a guess.

`npx create-react-app foo` parsed as the skill id "create-react-app" until 2026-08-07: any unrelated
npx command a user pasted would have installed a skill by that name. The module's own docstring says
None means "I could not read this", never a guess, so the registry name is now required."""

import pytest

from backend.apps.skill_registry.parse_install_command import parse_install_command

REAL_INSTALLS = [
    ("npx skills add pdf-filler", "pdf-filler"),
    ("$ npx skills add pdf-filler", "pdf-filler"),
    ("npm i skills pdf-filler", "pdf-filler"),
    ("bunx skills install pdf-filler", "pdf-filler"),
    ("pnpm skills add @acme/pdf-filler", "@acme/pdf-filler"),
    ("npx skills add pdf-filler --force", "pdf-filler"),
    ("https://skills.sh/s/pdf-filler", "pdf-filler"),
    ("pdf-filler", "pdf-filler"),
]

NOT_INSTALLS = [
    "npx create-react-app foo",
    "npm i lodash",
    "npx vite build",
    "yarn add react",
    "rm -rf /",
    "",
    "   ",
]


@pytest.mark.parametrize("raw,expected", REAL_INSTALLS)
def test_the_forms_people_actually_paste_still_parse(raw, expected):
    assert parse_install_command(raw) == expected


@pytest.mark.parametrize("raw", NOT_INSTALLS)
def test_anything_that_is_not_a_skills_install_is_refused(raw):
    assert parse_install_command(raw) is None, f"{raw!r} must not be read as a skill id"

def test_dlx_is_the_form_readmes_actually_print():
    """`pnpm dlx` / `yarn dlx` are those managers' npx; missing them meant the most common paste failed."""
    assert parse_install_command("pnpm dlx skills add note-taker") == "note-taker"
    assert parse_install_command("yarn dlx skills add note-taker") == "note-taker"
    assert parse_install_command("pnpm exec skills add note-taker") == "note-taker"


def test_dlx_does_not_widen_the_refusals():
    """Skipping the runner subcommand must not turn every dlx invocation into an install."""
    assert parse_install_command("pnpm dlx create-vite my-app") is None
    assert parse_install_command("yarn dlx prettier --write .") is None
