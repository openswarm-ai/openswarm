"""The Tisusa client's bundle, by shape (2026-09-04, ENG-463): 507 workspace files nested up to eight
deep, seven dotfiles, two names with spaces, an 80-character path, one 1.2 MB file. The real bundle
is the client's code, so this rebuilds its SHAPE with placeholder contents and drives it through the
real exporter, the real staging reader and the real app importer, on whatever OS runs the test. On
Windows this is the path that used to save a hollow app; `.github/workflows/swarm-import-drill.yml`
runs it on windows-latest."""

import os
import zipfile

from backend.apps.outputs.models import Output
from backend.apps.outputs.workspace_io import load_output, save
from backend.apps.swarm import closure
from backend.apps.swarm.entities import apps as appmod
from backend.apps.swarm.models import EntityType

# depth -> how many files sit at that depth, read off the client's bundle
TISUSA_DEPTHS = {0: 28, 1: 29, 2: 27, 3: 130, 4: 107, 5: 60, 6: 72, 7: 49, 8: 5}
DOTFILES = [".env.example", ".gitattributes", ".gitignore", ".prettierrc", ".eslintrc.json", ".npmrc", ".nvmrc"]
SPACED = ["docs/Design Notes.md", "public/brand assets/logo.svg"]
LONG_PATH = "app/features/settings/integrations/providers/components/ProviderCredentialFo.tsx"
BIG_FILE = "public/hero.png"


def build_tisusa_shaped_tree(root: str) -> list[str]:
    rels: list[str] = list(DOTFILES) + SPACED + [LONG_PATH, BIG_FILE]
    fixed_by_depth = {}
    for r in rels:
        fixed_by_depth[r.count("/")] = fixed_by_depth.get(r.count("/"), 0) + 1
    for depth, count in TISUSA_DEPTHS.items():
        for i in range(count - fixed_by_depth.get(depth, 0)):
            parts = [f"d{depth}_{j}" for j in range(depth)] + [f"f{i}.ts"]
            rels.append("/".join(parts))
    assert len(rels) == sum(TISUSA_DEPTHS.values()) == 507
    assert len(LONG_PATH) == 80
    for rel in rels:
        full = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(b"\x89PNG" + os.urandom(1_262_398 - 4) if rel == BIG_FILE else f"// {rel}\n".encode())
    return rels


def test_a_tisusa_shaped_bundle_round_trips_with_every_file_on_this_os():
    ws = "tisusa-shaped-src"
    src = os.path.join(appmod.OUTPUTS_WORKSPACE_DIR, ws)
    rels = build_tisusa_shaped_tree(src)
    o = Output(name="Tisusa shaped", workspace_id=ws)
    save(o)

    raw, name = closure.build_bundle(EntityType.app, o.id)
    with zipfile.ZipFile(__import__("io").BytesIO(raw)) as zf:
        members = [n for n in zf.namelist() if "/files/workspace/" in n]
    assert len(members) == 507
    assert not any("\\" in m for m in members), "a bundle member name carried a backslash"

    sandbox, manifest, warnings = closure.stage_upload(raw, f"{name}.swarm")
    # The staging reader is the line that broke on Windows: its keys must be slash-separated on THIS OS.
    ref = next(e for e in manifest.entities if e.type == EntityType.app)
    keys = list(closure.p_read_files(sandbox, ref))
    assert len(keys) == 507 and all(k.startswith("workspace/") for k in keys), f"bad keys: {[k for k in keys if not k.startswith('workspace/')][:3]}"

    root_type, root_id, created, unresolved = closure.commit(sandbox, manifest, [])
    assert root_type == EntityType.app
    imported = load_output(root_id)
    assert imported is not None and imported.workspace_id, "the app imported without a workspace (the hollow-app shape)"
    dest = os.path.join(appmod.OUTPUTS_WORKSPACE_DIR, imported.workspace_id)
    on_disk = sorted(os.path.relpath(os.path.join(r, f), dest).replace(os.sep, "/") for r, _, fs in os.walk(dest) for f in fs)
    # 507 from the bundle plus the .env the importer regenerates from .env.example for this machine (the
    # real Tisusa import lands 508 the same way).
    assert ".env" in on_disk, "the importer did not localize an .env from .env.example"
    landed = [r for r in on_disk if r != ".env"]
    assert len(landed) == 507, f"{len(landed)} files landed, expected 507"
    for rel in DOTFILES + SPACED + [LONG_PATH, BIG_FILE]:
        assert rel in landed, f"{rel} did not land"
    assert os.path.getsize(os.path.join(dest, *BIG_FILE.split("/"))) == 1_262_398
    assert sorted(rels) == landed
