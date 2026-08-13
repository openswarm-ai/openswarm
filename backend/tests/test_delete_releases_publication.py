"""Deleting a published app must take its public URL down (ENG-282).

Measured live on 1.7.8-exp.1 against prod before this test existed. Same app,
same URL, same probe, minutes apart, only the endpoint differing:

    unpublish -> HTTP 200 marker=1  becomes  HTTP 404 marker=0
    delete    -> HTTP 200 marker=1  becomes  HTTP 200 marker=1

`delete_output` stopped every runtime, rmtree'd the workspace and removed the
record, and never once looked at `published_slug`. The record holding that slug
was destroyed first, so the app ended up reachable by anyone with the link and
unreachable by its owner. Pressing Delete published your app forever.

The seal is ordering plus a single owner: release the publication BEFORE any
local destruction, and refuse to destroy anything if the release failed, so
"deleted locally, live publicly" cannot be reached from any deletion path.

Run:
    backend/.venv/bin/python -m pytest backend/tests/test_delete_releases_publication.py -v
"""

import os
from typing import Any, List

import pytest
from fastapi import HTTPException

from backend.apps.outputs import outputs as outputs_module
from backend.apps.outputs import release_publication as release_module
from backend.apps.outputs.models import Output
from backend.apps.outputs.publish_common import PublishError


class P_Recorder:
    """Stands in for the cloud so the test never touches the network."""

    def __init__(self, fail: bool = False) -> None:
        self.slugs: List[str] = []
        self.fail = fail

    async def __call__(self, settings: Any, slug: str) -> None:
        self.slugs.append(slug)
        if self.fail:
            raise PublishError("cloud said no")


def p_make_output(tmp_path: Any, published: bool) -> Output:
    out = Output(name="probe", description="", files={"index.html": "<h1>x</h1>"})
    if published:
        out.published_slug = "probe-slug"
        out.published_url = "https://probe-slug.openswarm.host"
    outputs_module.save(out)
    return out


@pytest.fixture
def p_isolated(tmp_path: Any, monkeypatch: Any) -> Any:
    monkeypatch.setattr(outputs_module, "DATA_DIR", str(tmp_path), raising=False)
    os.makedirs(str(tmp_path), exist_ok=True)
    return tmp_path


@pytest.mark.asyncio
async def test_deleting_a_published_app_releases_the_publication(p_isolated: Any, monkeypatch: Any) -> None:
    """The bug, stated as an assertion. Fails before the fix: zero slugs released."""
    rec = P_Recorder()
    monkeypatch.setattr(release_module, "unpublish_from_cloud", rec)
    out = p_make_output(p_isolated, published=True)

    await outputs_module.delete_output(out.id)

    assert rec.slugs == ["probe-slug"], (
        f"delete never released the publication; cloud saw {rec.slugs}. "
        "The app is now live at a URL its owner can no longer reach."
    )


@pytest.mark.asyncio
async def test_a_failed_release_leaves_the_record_intact(p_isolated: Any, monkeypatch: Any) -> None:
    """Ordering is the other half. If the release fails, nothing local may be destroyed,
    because the record is the only thing that still knows the slug."""
    rec = P_Recorder(fail=True)
    monkeypatch.setattr(release_module, "unpublish_from_cloud", rec)
    out = p_make_output(p_isolated, published=True)

    with pytest.raises(HTTPException) as caught:
        await outputs_module.delete_output(out.id)
    assert caught.value.status_code >= 400

    still_there = outputs_module.load(out.id)
    assert still_there.published_slug == "probe-slug", (
        "the record was destroyed after a failed release, so the slug is unrecoverable"
    )


@pytest.mark.asyncio
async def test_an_unpublished_app_still_deletes_cleanly(p_isolated: Any, monkeypatch: Any) -> None:
    """The other direction, so a fix that merely blocks deletion is caught too."""
    rec = P_Recorder()
    monkeypatch.setattr(release_module, "unpublish_from_cloud", rec)
    out = p_make_output(p_isolated, published=False)

    await outputs_module.delete_output(out.id)

    assert rec.slugs == [], "an unpublished app must not call the cloud at all"
    assert not os.path.exists(os.path.join(str(p_isolated), f"{out.id}.json"))
