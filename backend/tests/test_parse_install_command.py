"""Pasting the command from a README must install the skill. Guessing wrong is worse than asking,
so anything unreadable returns None rather than a best effort."""

import pytest

from backend.apps.skill_registry.parse_install_command import parse_install_command


@pytest.mark.parametrize("cmd", [
    "npx skills add pdf-filler",
    "npx skills install pdf-filler",
    "npm i skills pdf-filler",
    "pnpm skills add pdf-filler",
    "bunx skills add pdf-filler",
    "$ npx skills add pdf-filler",
    "npx --yes skills add pdf-filler",
    "npx skills add   pdf-filler  ",
])
def test_every_common_runner_and_verb_resolves_the_same_skill(cmd):
    assert parse_install_command(cmd) == "pdf-filler"


def test_scoped_names_survive():
    assert parse_install_command("npx skills add @anthropic/docx") == "@anthropic/docx"
    assert parse_install_command("@anthropic/docx") == "@anthropic/docx"


def test_a_bare_name_is_accepted():
    assert parse_install_command("pdf-filler") == "pdf-filler"


def test_urls_carry_their_id_in_the_last_segment():
    assert parse_install_command("https://skills.sh/s/pdf-filler") == "pdf-filler"
    assert parse_install_command("https://skills.sh/s/pdf-filler/") == "pdf-filler"
    assert parse_install_command("https://skills.sh/s/pdf-filler?ref=x") == "pdf-filler"


@pytest.mark.parametrize("junk", [
    "", "   ", "npx skills add", "npm install", "how do i install a skill",
    "rm -rf /", "npx skills add ; rm -rf /",
])
def test_unreadable_input_returns_none_rather_than_a_guess(junk):
    assert parse_install_command(junk) is None
