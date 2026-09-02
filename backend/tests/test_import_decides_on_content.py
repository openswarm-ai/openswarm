"""A zip is judged by what its manifest CONTAINS, not by the fact that one is named manifest.json.

Found live 2026-09-02 on a package published to the marketplace: a plain skill zip carrying its own
unrelated `manifest.json` (name/kind/version) was rejected as "bundle manifest is invalid", because
staging keyed on the filename alone. The half that must not get lost while fixing that is the
strict path: anything shaped like OUR manifest still has to fail loudly when it has been tampered
with, rather than being quietly reinterpreted as a skill.
"""

import io
import json
import shutil
import zipfile

import pytest

from backend.apps.swarm import closure
from backend.apps.swarm.models import EntityType
from backend.apps.swarm.ziputil import BundleError

FOREIGN_MANIFEST = {"name": "hello-world", "kind": "skill", "version": "1.0.0", "description": "hi"}
SKILL_MD = "---\nname: hello-world\ndescription: Says hello\n---\n\nSay hello.\n"


def p_zip(members: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in members.items():
            z.writestr(name, body)
    return buf.getvalue()


def test_a_skill_zip_with_someone_elses_manifest_installs_as_a_skill():
    raw = p_zip({"manifest.json": json.dumps(FOREIGN_MANIFEST), "SKILL.md": SKILL_MD})
    sandbox, manifest, warnings = closure.stage_upload(raw, "hello-world.swarm")
    try:
        assert manifest.root.type == EntityType.skill
        assert closure.summarize(manifest).root.type == EntityType.skill
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)


def test_a_manifest_shaped_like_ours_still_fails_loudly_when_it_is_broken():
    """The negative control for the fallthrough: a damaged bundle of ours must never be salvaged
    into a skill install, because that would turn a tamper check into a silent downgrade."""
    ours = {"bundle_id": "abc", "root": {"type": "app", "bundle_id": "abc", "name": "X", "path": "entities/abc"},
            "entities": [], "checksum": "0" * 64, "format_version": 1}
    raw = p_zip({"manifest.json": json.dumps(ours), "SKILL.md": SKILL_MD})
    with pytest.raises(BundleError):
        closure.stage_upload(raw, "tampered.swarm")


def test_the_discriminator_reads_the_three_keys_only_our_manifest_has():
    assert closure.looks_like_our_manifest({"bundle_id": "a", "root": {}, "entities": []}) is True
    assert closure.looks_like_our_manifest(FOREIGN_MANIFEST) is False
    assert closure.looks_like_our_manifest(["not", "a", "dict"]) is False


def test_a_zip_that_is_neither_says_so_rather_than_installing_something():
    raw = p_zip({"manifest.json": json.dumps(FOREIGN_MANIFEST), "README.txt": "nothing to install"})
    with pytest.raises(BundleError):
        closure.stage_upload(raw, "empty.swarm")
