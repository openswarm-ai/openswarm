"""A SKILL.md whose description uses a YAML block scalar rendered as the literal string "|-" on
its marketplace card (ENG-307, seen live on /claude-api). The line-regex parser matched the
indicator as the value and dropped the indented block below it. One parser now serves both the
registry and the upload path, and it reads block scalars.
"""
from backend.apps.skill_registry.skill_registry_github import parse_frontmatter


def test_literal_block_scalar_reads_the_indented_text():
    meta, body = parse_frontmatter("---\nname: claude-api\ndescription: |-\n  Talk to the API\n  with retries.\n---\nBody")
    assert meta["description"] == "Talk to the API\nwith retries."
    assert meta["name"] == "claude-api"
    assert body == "Body"


def test_folded_scalar_joins_with_spaces():
    meta, _ = parse_frontmatter("---\ndescription: >-\n  One line\n  folded.\n---\n")
    assert meta["description"] == "One line folded."


def test_plain_and_quoted_values_are_unchanged():
    meta, _ = parse_frontmatter('---\nname: "quoted"\nlicense: MIT\n---\n')
    assert meta == {"name": "quoted", "license": "MIT"}


def test_empty_block_scalar_yields_empty_not_the_indicator():
    meta, _ = parse_frontmatter("---\ndescription: |-\nname: x\n---\n")
    assert meta["description"] == ""
    assert meta["name"] == "x"


def test_upload_path_uses_the_same_parser():
    # p_parse_skill_frontmatter is file-private to skills.py; assert the delegation in source so
    # the two paths can never drift back into separate parsers (the bug was exactly that fork).
    import backend.apps.skills.skills as skills_mod
    src = open(skills_mod.__file__).read()
    body = src[src.index("def p_parse_skill_frontmatter"):]
    assert "parse_frontmatter(raw)[0]" in body.split("def ", 2)[1]
