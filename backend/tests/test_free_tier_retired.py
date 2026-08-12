"""The free tier is retired. It was never something a user picked: the app minted it at boot for
anyone with no key, and while armed it silently pinned every session to Haiku mid-run, so people ran
a different model than the one they chose with no indication. These pin the removal in all three
places it has to hold: nobody new gets in, nobody already in stays, and the pin itself is gone."""

from backend.apps.settings.store import migrate_legacy_fields
from backend.apps.settings.models import AppSettings
from backend.apps.agents.providers.registry import resolve_model_id_for_sdk


def test_an_install_already_on_the_free_tier_is_moved_off_it():
    raw = migrate_legacy_fields({"connection_mode": "free-trial", "free_trial_token": "tok-abc"})
    assert raw["connection_mode"] == "own_key"
    assert "free_trial_token" not in raw, "a retired tier must not leave its credential behind"


def test_the_migration_leaves_every_other_mode_alone():
    for mode in ("own_key", "openswarm-pro", "custom"):
        assert migrate_legacy_fields({"connection_mode": mode})["connection_mode"] == mode


def test_the_chosen_model_is_the_model_that_runs():
    # The old behavior rewrote short_name to "haiku" whenever the mode was free-trial, which is the
    # reported "swapped me to a different model halfway through" with no indication.
    s = AppSettings(connection_mode="own_key")
    assert "opus" in resolve_model_id_for_sdk("opus-5", s).lower()
    assert "sonnet" in resolve_model_id_for_sdk("sonnet-5", s).lower()


def test_no_haiku_pin_survives_even_if_the_retired_mode_is_forced_in():
    # Belt over the migration: hand the resolver the retired mode directly and it must still honor
    # the caller's model rather than reaching for Haiku.
    s = AppSettings()
    object.__setattr__(s, "__dict__", {**s.__dict__, "connection_mode": "free-trial"})
    assert "haiku" not in resolve_model_id_for_sdk("opus-5", s).lower()


def test_nothing_in_the_app_mints_a_free_trial_on_boot():
    """The mint was fired unconditionally from the renderer's boot effect, which is why the tier was
    still shipping long after the decision to drop it. Guard the renderer, not just the backend."""
    from pathlib import Path
    main_tsx = Path(__file__).resolve().parents[2] / "frontend" / "src" / "app" / "Main.tsx"
    assert "free-trial/mint" not in main_tsx.read_text(encoding="utf-8"), (
        "Main.tsx arms the retired free tier at boot again"
    )
