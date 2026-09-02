"""The marketplace catalog and its one install door.

Two things here are load-bearing and are asserted rather than assumed: the catalog is a spreadsheet
other people can edit, so a row's download URL is untrusted input, and install must go through the
SAME staging door a dropped .swarm uses, or the secret review and the never-install-a-skill-silently
rule would exist in one door and not the other.
"""

import inspect

import pytest

from backend.apps.marketplace import catalog, marketplace
from backend.apps.marketplace.package_download import (
    DownloadRefused,
    download_package,
    host_allowed,
)

SHEET = (
    "id,title,kind,version,author,description,tags,icon_url,download_url,size,updated_at,video_url,bundle_items\n"
    "hello,Hello World,skill,1.0.0,Test,Says hello,demo,,https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view,12 KB,2026-09-01,,\n"
    ",Derived Title,app,,Someone,No id column,,,https://example.com/x.swarm,,,,\n"
    ",,,,,,,,,,,,\n"
    "pack,Starter Pack,bundle,,Team,Two things,,,,,2026-09-02,,hello, hello ,\n"
)


def p_listing(rows, listing_id):
    return next(row for row in rows if row.id == listing_id)


def test_a_drive_share_link_becomes_something_an_installer_can_fetch():
    rows = catalog.parse_csv(SHEET)
    assert p_listing(rows, "hello").download_url == (
        "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUv"
    )


def test_a_row_without_an_id_gets_one_from_its_title_and_a_blank_row_is_dropped():
    rows = catalog.parse_csv(SHEET)
    assert [row.id for row in rows] == ["hello", "derived-title", "pack"]


def test_an_unknown_column_is_ignored_rather_than_rejected():
    rows = catalog.parse_csv("id,title,kind,publisher_notes\nx,X,skill,anything at all\n")
    assert rows[0].id == "x" and rows[0].kind == "skill"


def test_several_demo_videos_in_one_cell_each_normalize_and_keep_their_order():
    raw = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view\nhttps://youtu.be/abcdefghijk"
    rows = catalog.parse_csv(f"id,title,video_url\nv,V,\"{raw}\"\n")
    assert rows[0].video_url.split("\n") == [
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/preview",
        "https://youtu.be/abcdefghijk",
    ]


@pytest.mark.parametrize(
    "url,allowed",
    [
        ("https://drive.google.com/uc?export=download&id=x", True),
        ("https://drive.usercontent.google.com/download?id=x", True),
        ("https://raw.githubusercontent.com/o/r/main/a.swarm", True),
        # The sheet is editable by other people, so these are the shapes that must never resolve.
        ("http://drive.google.com/uc?id=x", False),
        ("https://drive.google.com.evil.example/a.swarm", False),
        ("https://127.0.0.1/a.swarm", False),
        ("https://169.254.169.254/latest/meta-data", False),
        ("file:///etc/passwd", False),
        ("", False),
    ],
)
def test_only_hosts_we_publish_from_are_fetchable(url, allowed):
    assert host_allowed(url) is allowed


def test_a_refused_host_never_reaches_the_network():
    with pytest.raises(DownloadRefused):
        download_package("https://evil.example/package.swarm")


def test_a_redirect_off_the_allowlist_is_refused_mid_chain():
    from backend.apps.marketplace.package_download import AllowlistRedirectHandler

    handler = AllowlistRedirectHandler()
    with pytest.raises(DownloadRefused):
        handler.redirect_request(None, None, 302, "Found", {}, "https://127.0.0.1/pkg.swarm")


def test_an_unreachable_sheet_serves_the_last_good_catalog_instead_of_an_empty_store(monkeypatch):
    monkeypatch.setattr(catalog, "fetch_sheet_csv", lambda url: SHEET)
    good = catalog.load_catalog(force=True)
    assert good.source == "sheet" and good.count == 3

    def p_down(url):
        raise OSError("no network")

    monkeypatch.setattr(catalog, "fetch_sheet_csv", p_down)
    stale = catalog.load_catalog(force=True)
    assert stale.source == "cache", "a flaky network must not look like an empty marketplace"
    assert [row.id for row in stale.listings] == [row.id for row in good.listings]
    assert "Could not refresh" in stale.error


def test_with_no_cache_at_all_an_unreachable_sheet_is_honest_rather_than_silent(monkeypatch):
    monkeypatch.setattr(catalog, "p_cache", None)

    def p_down(url):
        raise OSError("no network")

    monkeypatch.setattr(catalog, "fetch_sheet_csv", p_down)
    empty = catalog.load_catalog(force=True)
    assert empty.source == "empty" and empty.count == 0 and empty.error


def test_a_caller_names_a_listing_id_never_a_url():
    """The install request model carries only an id, so no caller can make the backend fetch a URL
    of their choosing; the URL is resolved from the catalog WE fetched."""
    assert set(marketplace.InstallRequest.model_fields) == {"id"}


def test_install_stages_through_the_same_door_as_a_dropped_file():
    from backend.apps.swarm import swarm as swarm_routes

    assert marketplace.stage_bundle_for_import is swarm_routes.stage_bundle_for_import
    body = inspect.getsource(marketplace.install_preflight)
    assert "stage_bundle_for_import" in body
    for forbidden in ("write_folder_skill", "closure.commit", "import_commit"):
        assert forbidden not in body, "install must never write; it stages and lets the user confirm"
