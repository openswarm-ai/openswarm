"""The scanner blocks an export, so a false positive costs the user something they cannot fix.

Reported by Haik Decie: exporting a skill failed with "a secret-shaped value is in
.../packaging/licenses/_spdx.py; remove it" and there was no secret to remove. The SPDX licence id
`Asterisk-linking-protocols-exception` contains `sk-linking-protocols-exception`, and the pattern
counted dashes as key material.
"""

from backend.common.secret_scan import looks_secret, redact_secret_shapes


def test_a_licence_identifier_is_not_a_key():
    assert looks_secret("Asterisk-linking-protocols-exception") is False
    assert looks_secret("sk-linking-protocols-exception") is False


def test_real_key_shapes_are_still_caught():
    # The control that keeps this from being a blanket weakening.
    assert looks_secret("sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0") is True
    assert looks_secret("sk-ant-api03-" + "x" * 95) is True
    assert looks_secret("sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2") is True
    assert looks_secret("AIza" + "B" * 30) is True
    assert looks_secret("ghp_" + "c" * 30) is True


def test_other_dictionary_dashed_words_stay_clear():
    for benign in ("task-list-runner-exception", "disk-usage-report-helper",
                   "risk-scoring-model-weights", "sk-a-b-c-d-e-f"):
        assert looks_secret(benign) is False, benign


def test_redaction_still_removes_a_real_key():
    out = redact_secret_shapes("key=sk-proj-" + "z" * 40)
    assert "sk-proj-" not in out and "[redacted]" in out
