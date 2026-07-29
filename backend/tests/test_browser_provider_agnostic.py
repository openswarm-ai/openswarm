"""The browser agent must never name a provider's model.

A user driving the browser on ChatGPT or Gemini has no Claude lane at all, so a single hardcoded
model id is not a slow path, it is a dead one. The rule from CLAUDE.md is that aux calls ask the
registry for a TIER ("haiku", "sonnet") and the registry returns whatever the user actually
connected. Tier names are fine; model ids are not.

This caught real debt: browser_agent imported a MODEL_MAP of three claude-* ids that nothing used,
left behind after the resolve_aux_model migration. Dead, but it made the whole package read as
Claude-only to anyone auditing it, and a dead map is exactly the thing someone later wires back up.

Comments are deliberately exempt. A comment recording that cx/gpt-5.4-mini returned an empty body
is evidence worth keeping; it cannot route a request.
"""
import io
import pathlib
import re
import tokenize

# Concrete, dated model ids. Not "gemini.google.com" (a host) and not "haiku" (a tier).
P_MODEL_ID_RE = re.compile(
    r"claude-(?:sonnet|opus|haiku)-[\w.-]+|gpt-5[\w.-]*|gemini-[0-9][\w.-]*")

P_BROWSER_DIR = pathlib.Path(__file__).resolve().parents[1] / "apps" / "agents" / "browser"


def p_model_ids_in_code(path: pathlib.Path):
    """Every concrete model id appearing in a STRING literal, with its line number."""
    hits = []
    with path.open() as f:
        for tok in tokenize.generate_tokens(f.readline):
            if tok.type != tokenize.STRING:
                continue
            for m in P_MODEL_ID_RE.finditer(tok.string):
                hits.append((tok.start[0], m.group(0)))
    return hits


def test_no_browser_module_names_a_providers_model():
    offenders = []
    for path in sorted(P_BROWSER_DIR.glob("*.py")):
        for line, model in p_model_ids_in_code(path):
            offenders.append(f"{path.name}:{line} -> {model}")
    assert not offenders, (
        "browser modules must ask resolve_aux_model for a tier, never name a model:\n  "
        + "\n  ".join(offenders))


def test_the_guard_would_actually_catch_a_regression():
    """A test that can never fail is not a guard. Prove the detector fires on the exact shape that
    was just removed, so a future MODEL_MAP cannot slip back in under a green suite."""
    source = 'MODEL_MAP = {"sonnet": "claude-sonnet-4-6", "haiku": "claude-haiku-4-5-20251001"}\n'
    found = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.STRING:
            found += [m.group(0) for m in P_MODEL_ID_RE.finditer(tok.string)]
    assert found == ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]


def test_tier_names_and_hostnames_are_not_flagged():
    """The guard must leave the legitimate vocabulary alone, or it will just get deleted."""
    source = 'x = "haiku"\ny = "sonnet"\nz = "gemini.google.com"\nw = "chat.openai.com"\n'
    found = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.STRING:
            found += [m.group(0) for m in P_MODEL_ID_RE.finditer(tok.string)]
    assert not found


def test_every_aux_call_asks_for_a_tier():
    """resolve_aux_model's preferred_tier must be a tier literal. If a model id ever gets passed
    here the call still works on Claude and silently dies for everyone else, which is precisely
    the failure that is invisible on the developer's own machine."""
    call_re = re.compile(r"preferred_tier\s*=\s*\"([^\"]+)\"")
    bad = []
    for path in sorted(P_BROWSER_DIR.glob("*.py")):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            for m in call_re.finditer(line):
                if m.group(1) not in ("haiku", "sonnet", "opus"):
                    bad.append(f"{path.name}:{i} -> {m.group(1)}")
    assert not bad, f"preferred_tier must be a tier, not a model: {bad}"
