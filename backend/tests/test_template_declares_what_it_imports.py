"""Every third-party module a generated app imports must be declared by the template (ENG-287).

The filed premise was wrong and the measurement said so: nothing in the template imports
pydantic, `app_builder_skill.md` never mentions it, and fastapi declares `pydantic>=2.9.0`
as a core dependency, so there was no live breakage. What was true is narrower: the
template relied on a package it never asked for.

This test is the general form, not the pydantic special case. It reads what the template
actually imports and asserts the manifest covers it, so the next helper an agent leans on
cannot become an undeclared dependency quietly.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_template_declares_what_it_imports.py -v
"""

import ast
import os
import re
from typing import List, Set

TEMPLATE = os.path.join("backend", "apps", "outputs", "webapp_template", "backend")
# Shipped with the app, not from PyPI, so they are not manifest entries.
P_LOCAL_PACKAGES = {"backend", "config", "apps"}
P_STDLIB_HINT = {
    "os", "sys", "json", "typing", "pathlib", "asyncio", "logging", "datetime", "time",
    "re", "subprocess", "shutil", "uuid", "contextlib", "dataclasses", "enum", "math",
    "collections", "functools", "itertools", "tempfile", "io", "base64", "hashlib",
    "sqlite3", "csv", "random", "traceback", "urllib", "http", "socket", "threading",
}


def p_declared() -> Set[str]:
    """Only the dependencies array. Scraping the whole file also picked up the project name and
    version, which pad the declared set and could hide a genuinely missing package."""
    with open(os.path.join(TEMPLATE, "pyproject.toml")) as fh:
        body = fh.read()
    # The closing bracket must be the one at line start: a non-greedy .*? stops at the "]" inside
    # "fastapi[standard]" and silently returns an EMPTY declared set, which marks everything missing.
    block = re.search(r"^dependencies\s*=\s*\[(.*?)^\]", body, re.S | re.M)
    assert block, "no dependencies array in the template pyproject.toml"
    names = re.findall(r'"([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?(?:[<>=!~][^"]*)?"', block.group(1))
    return {n.split("[")[0].lower().replace("-", "_") for n in names}


def p_imported() -> Set[str]:
    found: Set[str] = set()
    for base, dirs, files in os.walk(TEMPLATE):
        for fn in files:
            if not fn.endswith(".py"):
                continue
            with open(os.path.join(base, fn)) as fh:
                try:
                    tree = ast.parse(fh.read())
                except SyntaxError:
                    continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for a in node.names:
                        found.add(a.name.split(".")[0])
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    found.add(node.module.split(".")[0])
    return {m.lower() for m in found}


def test_the_template_declares_every_third_party_import() -> None:
    imported = p_imported()
    assert imported, "walked the template and found no imports at all; the scan is broken"
    third_party = {m for m in imported if m not in P_STDLIB_HINT and m not in P_LOCAL_PACKAGES}
    declared = p_declared()
    missing: List[str] = sorted(m for m in third_party if m.replace("-", "_") not in declared)
    assert not missing, (
        f"the template imports {missing} without declaring them; a generated app then relies on "
        f"whatever a transitive dependency happens to provide. declared={sorted(declared)}"
    )


def test_pydantic_is_declared_even_though_fastapi_provides_it() -> None:
    """The specific case that started this. Agents write BaseModel constantly; asking for the
    package is how that stops being someone else's transitive gift."""
    assert "pydantic" in p_declared()


def test_the_scan_actually_reads_files() -> None:
    """A walk that silently matches nothing would make the check above vacuously true."""
    assert len(p_imported()) >= 3, f"only found {p_imported()}, the template scan is not working"
