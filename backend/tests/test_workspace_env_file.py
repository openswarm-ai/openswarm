"""The workspace `.env` OpenSwarm writes at seed time is sourced by the template's bash scripts and parsed by
`read_env_value`: every value must round-trip through both, including install paths with spaces or backslashes."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.apps.outputs.runtime_proc import read_env_value
from backend.apps.outputs.view_builder_templates import patch_env_port


def write_seed_env(path: Path) -> None:
    path.write_text("BACKEND_PORT=NONE # backend port\nFRONTEND_PORT=4949\n", encoding="utf-8")


def test_plain_values_are_written_bare(tmp_path):
    env = tmp_path / ".env"
    write_seed_env(env)
    patch_env_port(str(env), "FRONTEND_PORT", "5151")
    patch_env_port(str(env), "OPENSWARM_TEMPLATE_BACKEND_PATH", "/opt/openswarm/template/backend")
    text = env.read_text(encoding="utf-8")
    assert "FRONTEND_PORT=5151\n" in text
    assert "OPENSWARM_TEMPLATE_BACKEND_PATH=/opt/openswarm/template/backend\n" in text
    assert "BACKEND_PORT=NONE # backend port\n" in text
    assert read_env_value(str(env), "FRONTEND_PORT") == "5151"


@pytest.mark.parametrize(
    "value",
    [
        "/Users/Jane Doe/Applications/OpenSwarm.app/Contents/Resources/backend/apps/outputs/webapp_template/backend",
        r"C:\Users\Jane Doe\AppData\Local\OpenSwarm\app-1.7.7\resources\backend\template",
        "/tmp/it's here/backend",
    ],
)
def test_awkward_paths_round_trip_through_bash_and_read_env_value(tmp_path, value):
    env = tmp_path / ".env"
    write_seed_env(env)
    patch_env_port(str(env), "OPENSWARM_TEMPLATE_BACKEND_PATH", value)
    # Rewriting an existing key goes through the regex path too (a re-seed of an existing workspace).
    patch_env_port(str(env), "OPENSWARM_TEMPLATE_BACKEND_PATH", value)
    assert env.read_text(encoding="utf-8").count("OPENSWARM_TEMPLATE_BACKEND_PATH=") == 1
    if "'" not in value:  # read_env_value strips one pair of quotes; only bash needs the escaped-apostrophe form
        assert read_env_value(str(env), "OPENSWARM_TEMPLATE_BACKEND_PATH") == value
    bash = shutil.which("bash")
    if os.name == "nt":
        git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
        bash = os.fspath(git_bash) if git_bash.is_file() else bash
    if not bash:
        pytest.skip("bash is unavailable")
    result = subprocess.run(
        [bash, "-c", 'set -euo pipefail; set -a; source "$1"; set +a; printf "%s" "$OPENSWARM_TEMPLATE_BACKEND_PATH"', "-", str(env)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == value
