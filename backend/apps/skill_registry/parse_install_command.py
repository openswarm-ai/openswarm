"""Turn the install commands people already paste from READMEs into a skill id we can install.

The ecosystem's grammar is `npx skills add <name>`, and every neighbouring form (npm/pnpm/bunx,
`install` instead of `add`, a bare `@scope/name`, a skills.sh URL, or just the name) means the same
thing to the person pasting it. Accepting only our own button was the friction."""

import re
from typing import Optional

from typeguard import typechecked

# The runners people actually have in their muscle memory.
P_RUNNERS = ("npx", "npm", "pnpm", "pnpx", "yarn", "bunx", "bun", "deno")
P_VERBS = ("add", "install", "i")
# `pnpm dlx` and `yarn dlx` are those managers' npx, and dlx is the form READMEs actually print.
P_RUNNER_SUBCOMMANDS = ("dlx", "exec", "run")
P_SKILL_ID = re.compile(r"^[A-Za-z0-9@._/-]+$")


@typechecked
def parse_install_command(raw: str) -> Optional[str]:
    """Return the skill id a pasted command refers to, or None when it is not an install command.

    None means "I could not read this", never a guess: installing the wrong skill because a paste
    was ambiguous is worse than asking the user to pick from the list."""
    text = (raw or "").strip()
    if not text:
        return None
    # A skills.sh (or GitHub) URL carries the id in its last meaningful path segment.
    if text.startswith(("http://", "https://")):
        parts = [p for p in text.split("?")[0].split("#")[0].rstrip("/").split("/") if p]
        tail = parts[-1] if parts else ""
        return tail if tail and P_SKILL_ID.match(tail) else None

    # Strip a leading shell prompt or copy artifact ("$ npx ...").
    text = re.sub(r"^[$>#]\s*", "", text)
    tokens = text.split()
    if not tokens:
        return None

    if tokens[0].lower() in P_RUNNERS:
        # npx skills add <id> | npm i skills <id> | bunx skills add <id>
        rest = [t for t in tokens[1:] if not t.startswith("-")]
        if rest and rest[0].lower() in P_RUNNER_SUBCOMMANDS:
            rest = rest[1:]
        # The verb and the package name arrive in either order ("npx skills add x", "npm i skills x"),
        # so strip both, in whichever order they appear.
        named_registry = False
        for _ in range(2):
            if rest and rest[0].lower() in ("skills", "skill", "@skills/cli", "openswarm"):
                rest = rest[1:]
                named_registry = True
            elif rest and rest[0].lower() in P_VERBS:
                rest = rest[1:]
        # Without the registry name this is just some other npx command, and `npx create-react-app foo`
        # must never read as "install the create-react-app skill".
        if not named_registry:
            return None
        candidate = rest[0] if rest else ""
        return candidate if candidate and P_SKILL_ID.match(candidate) else None

    # A bare id or scoped package pasted on its own.
    if len(tokens) == 1 and P_SKILL_ID.match(tokens[0]) and "." not in tokens[0].split("/")[-1][:1]:
        return tokens[0]
    return None
