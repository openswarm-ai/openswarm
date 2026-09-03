"""The store must remember what it installed across restarts, and survive a bad file."""

import json

from backend.apps.marketplace.installs import InstallRecord, load_installs, record_install


def test_a_recorded_install_round_trips(tmp_path):
    p = str(tmp_path / "installs.json")
    record_install(InstallRecord(listing_id="git-graph", root_type="app", output_id="out-1", version="1.0.0"), p)
    record_install(InstallRecord(listing_id="hello", root_type="skill", skill_id="sk-1", version="1.0.0"), p)
    got = load_installs(p)
    assert set(got) == {"git-graph", "hello"}
    assert got["git-graph"].output_id == "out-1" and got["git-graph"].installed_at > 0


def test_reinstalling_replaces_the_record_for_that_listing(tmp_path):
    p = str(tmp_path / "installs.json")
    record_install(InstallRecord(listing_id="git-graph", root_type="app", output_id="out-1", version="1.0.0"), p)
    record_install(InstallRecord(listing_id="git-graph", root_type="app", output_id="out-2", version="1.1.0"), p)
    got = load_installs(p)
    assert len(got) == 1 and got["git-graph"].output_id == "out-2" and got["git-graph"].version == "1.1.0"


def test_a_missing_or_corrupt_file_reads_as_nothing_installed(tmp_path):
    p = str(tmp_path / "installs.json")
    assert load_installs(p) == {}
    (tmp_path / "installs.json").write_text("{not json")
    assert load_installs(p) == {}
    (tmp_path / "installs.json").write_text(json.dumps({"x": {"listing_id": "x"}}))
    assert load_installs(p) == {}
