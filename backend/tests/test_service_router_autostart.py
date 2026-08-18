from backend.apps.service import service


def test_9router_autostart_is_enabled_by_default(monkeypatch):
    monkeypatch.delenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", raising=False)

    assert service.should_autostart_9router() is True


def test_9router_autostart_can_be_disabled_for_hermetic_runs(monkeypatch):
    monkeypatch.setenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", "1")

    assert service.should_autostart_9router() is False


def test_9router_autostart_does_not_treat_other_values_as_disabled(monkeypatch):
    monkeypatch.setenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", "true")

    assert service.should_autostart_9router() is True
