"""Export = walk the dependency closure from a root, scrub, pack. Import = stage
into a sandbox, topo-sort leaves-first, assign fresh local ids, rewrite cross
refs through a RemapTable. The single-skill staging path lets a bare .md or a
zip-of-SKILL.md come in through the same commit machinery as a full .swarm."""
from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from uuid import uuid4

from backend.apps.swarm.exportable import RemapTable
from backend.apps.swarm.models import (
    FORMAT_VERSION,
    BundlePreview,
    BundleSummary,
    DependencyEdge,
    EntityRef,
    EntityType,
    IncludeItem,
    Manifest,
    Requirement,
    RequirementView,
)
from backend.apps.swarm.redact import scrub_payload
from backend.apps.swarm.registry import IMPORT_ORDER, get_exportable
from backend.apps.swarm.ziputil import MANIFEST_NAME, BundleError, has_member, is_zip, pack, read_manifest, unpack, verify_checksum


def p_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def p_created_with() -> str:
    return os.environ.get("OPENSWARM_VERSION") or "OpenSwarm"


class p_Ctx:
    def __init__(self, local_to_bundle: dict[tuple, str]):
        self.p_m = local_to_bundle

    def bundle_id_for(self, etype: EntityType, local_id: str) -> str | None:
        return self.p_m.get((etype, local_id))


# ---------- export ----------

def p_assemble(root_type: EntityType, root_id: str):
    root_cls = get_exportable(root_type)
    if root_cls is None:
        raise BundleError(f"can't share a {root_type.value} yet")
    root = root_cls.load(root_id)
    if root is None:
        raise BundleError("nothing found to share")

    nodes: dict[tuple, object] = {}
    order: list[tuple] = []
    queue: list[tuple] = [(root_type, root_id, root)]
    while queue:
        etype, lid, inst = queue.pop(0)
        key = (etype, lid)
        if key in nodes:
            continue
        nodes[key] = inst
        order.append(key)
        for dep in inst.dependencies():
            dkey = (dep.type, dep.local_id)
            if dkey in nodes:
                continue
            dcls = get_exportable(dep.type)
            if dcls is None:
                raise BundleError(f"can't bundle a dependency of type {dep.type.value} yet")
            dinst = dcls.load(dep.local_id)
            if dinst is not None:
                queue.append((dep.type, dep.local_id, dinst))

    local_to_bundle = {key: uuid4().hex for key in order}
    ctx = p_Ctx(local_to_bundle)
    payloads: dict[str, dict] = {}
    files: dict[str, bytes] = {}
    entities: list[EntityRef] = []
    edges: list[DependencyEdge] = []
    requirements: list[Requirement] = []
    counts: dict[str, int] = {}

    for key in order:
        etype, p_lid = key
        inst = nodes[key]
        bid = local_to_bundle[key]
        payloads[bid] = scrub_payload(inst.serialize(ctx))
        for rel, data in inst.files().items():
            files[f"entities/{bid}/files/{rel}"] = data
        entities.append(EntityRef(type=etype, bundle_id=bid, name=inst.name, path=f"entities/{bid}"))
        counts[etype.value] = counts.get(etype.value, 0) + 1
        for dep in inst.dependencies():
            dkey = (dep.type, dep.local_id)
            if dkey in local_to_bundle:
                edges.append(DependencyEdge(from_=bid, to=local_to_bundle[dkey], relation=dep.relation))
        requirements.extend(inst.requirements())

    requirements = p_dedupe_requirements(requirements)
    root_bid = local_to_bundle[(root_type, root_id)]
    manifest = Manifest(
        created_with=p_created_with(),
        created_at=p_now(),
        bundle_id=uuid4().hex,
        root=EntityRef(type=root_type, bundle_id=root_bid, name=root.name, path=f"entities/{root_bid}"),
        entities=entities,
        edges=edges,
        requirements=requirements,
        preview=BundlePreview(
            root_type=root_type,
            root_name=root.name,
            counts=counts,
            requirement_summary=[r.label for r in requirements],
        ),
    )
    return manifest, payloads, files


def build_manifest(root_type: EntityType, root_id: str) -> Manifest:
    return p_assemble(root_type, root_id)[0]


def build_bundle(root_type: EntityType, root_id: str, allow_file_secrets: bool = False) -> tuple[bytes, str]:
    manifest, payloads, files = p_assemble(root_type, root_id)
    raw = pack(manifest.model_dump(by_alias=True, mode="json"), payloads, files, allow_file_secrets=allow_file_secrets)
    return raw, manifest.root.name


def p_dedupe_requirements(reqs: list[Requirement]) -> list[Requirement]:
    out: dict[tuple, Requirement] = {}
    for r in reqs:
        k = (r.kind, r.key)
        if k in out:
            for ref in r.referenced_by:
                if ref not in out[k].referenced_by:
                    out[k].referenced_by.append(ref)
        else:
            out[k] = r
    return list(out.values())


# ---------- summary (shared by export + import preflight) ----------

def summarize(manifest: Manifest) -> BundleSummary:
    includes = [
        IncludeItem(type=e.type, name=e.name)
        for e in manifest.entities
        if e.bundle_id != manifest.root.bundle_id
    ]
    reqs = [RequirementView(kind=r.kind, key=r.key, label=r.label, detail=r.detail) for r in manifest.requirements]
    return BundleSummary(
        root=IncludeItem(type=manifest.root.type, name=manifest.root.name),
        includes=includes,
        requirements=reqs,
        counts=manifest.preview.counts,
    )


def swarm_filename(name: str) -> str:
    keep = "".join(c if (c.isalnum() or c in " -_") else "" for c in (name or "bundle")).strip()
    slug = keep.replace(" ", "-").lower() or "bundle"
    return f"{slug}.swarm"


# ---------- import: staging ----------

def validate_manifest(manifest: Manifest) -> None:
    """Structural integrity of the untrusted part of a .swarm. The checksum
    covers entity payloads + files but NOT the manifest itself, so an attacker
    can rewrite root/edges/paths freely; catch the breakages that would import
    silently wrong (a root pointing nowhere, a duplicate id that drops an
    entity, an edge or path that doesn't resolve inside the bundle)."""
    seen: set[str] = set()
    for e in manifest.entities:
        if e.bundle_id in seen:
            raise BundleError("bundle manifest has duplicate entity ids")
        seen.add(e.bundle_id)
        if not e.path.startswith("entities/") or ".." in e.path.split("/"):
            raise BundleError("bundle manifest has an out-of-tree entity path")
    if manifest.root.bundle_id not in seen:
        raise BundleError("bundle manifest root is not one of its entities")
    for edge in manifest.edges:
        if edge.from_ not in seen or edge.to not in seen:
            raise BundleError("bundle manifest has an edge to an unknown entity")


def stage_upload(raw: bytes, filename: str) -> tuple[str, Manifest, list[str]]:
    warnings: list[str] = []
    if is_zip(raw):
        if has_member(raw, MANIFEST_NAME):
            sandbox = unpack(raw)
            try:
                raw_manifest = read_manifest(sandbox)
                verify_checksum(sandbox, raw_manifest)
                manifest = Manifest(**raw_manifest)
                validate_manifest(manifest)
            except BundleError:
                shutil.rmtree(sandbox, ignore_errors=True)
                raise
            except Exception:
                shutil.rmtree(sandbox, ignore_errors=True)
                raise BundleError("bundle manifest is invalid")
            if manifest.format_version > FORMAT_VERSION:
                shutil.rmtree(sandbox, ignore_errors=True)
                raise BundleError("this .swarm was made by a newer OpenSwarm; please update")
            return sandbox, manifest, warnings
        return stage_skill_from_zip(raw, filename, warnings)
    return p_stage_skill_from_markdown(raw, filename, warnings)


def p_name_from_filename(filename: str) -> str:
    base = os.path.splitext(os.path.basename(filename or "skill"))[0]
    return base.replace("-", " ").replace("_", " ").strip().title() or "Imported Skill"


def p_stage_skill_from_markdown(raw: bytes, filename: str, warnings: list[str]):
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise BundleError("unrecognized file; expected a .swarm or a .md skill")
    return p_synth_single_skill(content, p_name_from_filename(filename), warnings)


def stage_skill_from_zip(raw: bytes, filename: str, warnings: list[str]):
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        mds = [n for n in zf.namelist() if n.lower().endswith(".md") and not n.endswith("/")]
        target = next((n for n in mds if os.path.basename(n).lower() == "skill.md"), None)
        if target is None and mds:
            target = mds[0]
        if target is None:
            raise BundleError("zip has no SKILL.md")
        content = zf.read(target).decode("utf-8", errors="replace")
        # Carry supporting files (scripts, templates) through as a folder skill, keyed relative to the SKILL.md's directory so a nested layout flattens onto the skill folder. Cap count + per-file size so a hostile zip can't balloon the install.
        base_dir = target.rsplit("/", 1)[0] + "/" if "/" in target else ""
        extra_files: dict[str, bytes] = {}
        for n in zf.namelist():
            if n.endswith("/") or n == target:
                continue
            rel = n[len(base_dir):] if base_dir and n.startswith(base_dir) else os.path.basename(n)
            if not rel or rel.startswith("."):
                continue
            info = zf.getinfo(n)
            if info.file_size > 2_000_000 or len(extra_files) >= 50:
                warnings.append("some oversized/extra supporting files were skipped")
                continue
            extra_files[rel] = zf.read(n)
    return p_synth_single_skill(content, p_name_from_filename(filename), warnings, extra_files)


def p_synth_single_skill(content: str, name: str, warnings: list[str], extra_files: dict[str, bytes] | None = None):
    bid = uuid4().hex
    sandbox = tempfile.mkdtemp(prefix="swarm-import-")
    edir = os.path.join(sandbox, "entities", bid)
    os.makedirs(edir, exist_ok=True)
    slug = name.lower().replace(" ", "-")
    payload = {"slug": slug, "name": name, "description": "", "command": slug, "content": content, "builtin": False}
    with open(os.path.join(edir, "payload.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)
    # Supporting files ride the same entities/<bid>/files/<rel> channel the commit reader (p_read_files) feeds into import_, so a zip-of-SKILL.md round-trips as a folder skill instead of getting flattened.
    for rel, data in (extra_files or {}).items():
        dest = p_safe_join(edir, os.path.join("files", rel))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
    ref = EntityRef(type=EntityType.skill, bundle_id=bid, name=name, path=f"entities/{bid}")
    manifest = Manifest(
        bundle_id=uuid4().hex,
        root=ref,
        entities=[ref],
        preview=BundlePreview(root_type=EntityType.skill, root_name=name, counts={"skill": 1}),
    )
    return sandbox, manifest, warnings


# ---------- import: commit ----------

def p_safe_join(sandbox: str, rel: str) -> str:
    dest = os.path.realpath(os.path.join(sandbox, rel))
    root = os.path.realpath(sandbox)
    if dest != root and not dest.startswith(root + os.sep):
        raise BundleError("bundle manifest references a path outside the bundle")
    return dest


def p_read_payload(sandbox: str, ref: EntityRef) -> dict:
    path = p_safe_join(sandbox, os.path.join(ref.path, "payload.json"))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def p_read_files(sandbox: str, ref: EntityRef) -> dict[str, bytes]:
    base = p_safe_join(sandbox, os.path.join(ref.path, "files"))
    out: dict[str, bytes] = {}
    if not os.path.isdir(base):
        return out
    for root, p_dirs, fnames in os.walk(base):
        for fn in fnames:
            full = os.path.join(root, fn)
            with open(full, "rb") as f:
                out[os.path.relpath(full, base)] = f.read()
    return out


def review_bundle(sandbox: str, manifest: Manifest):
    """Safety read of any app code in the staged bundle. Returns None when the
    bundle contains no apps (nothing to review)."""
    from backend.apps.swarm.models import ReviewSummary
    from backend.apps.swarm.scan_app_files import scan_app_files

    findings: list[str] = []
    scanned: list[str] = []
    verdict = "clean"
    any_app = False
    for e in manifest.entities:
        if e.type != EntityType.app:
            continue
        any_app = True
        r = scan_app_files(p_read_files(sandbox, e))
        findings.extend(r.findings)
        scanned.extend(r.scanned_files)
        if r.verdict != "clean":
            verdict = r.verdict
    return ReviewSummary(verdict=verdict, findings=findings, scanned_files=scanned) if any_app else None


def detect_conflicts(sandbox: str, manifest: Manifest) -> list[IncludeItem]:
    out: list[IncludeItem] = []
    for e in manifest.entities:
        cls = get_exportable(e.type)
        check = getattr(cls, "conflict", None) if cls else None
        if not check:
            continue
        msg = check(p_read_payload(sandbox, e))
        if msg:
            out.append(IncludeItem(type=e.type, name=e.name, detail=msg))
    return out


def p_topo_order(manifest: Manifest) -> list[EntityRef]:
    entities = {e.bundle_id: e for e in manifest.entities}
    deps: dict[str, set[str]] = {bid: set() for bid in entities}
    for edge in manifest.edges:
        if edge.from_ in entities and edge.to in entities:
            deps[edge.from_].add(edge.to)
    tier = {t: i for i, t in enumerate(IMPORT_ORDER)}
    result: list[EntityRef] = []
    done: set[str] = set()
    remaining = set(entities)
    while remaining:
        ready = [b for b in remaining if deps[b] <= done] or list(remaining)
        ready.sort(key=lambda b: tier.get(entities[b].type, 99))
        nxt = ready[0]
        result.append(entities[nxt])
        done.add(nxt)
        remaining.discard(nxt)
    return result


def commit(sandbox: str, manifest: Manifest, accept_requirements: list[str]):
    remap = RemapTable()
    created: dict[str, list[str]] = {}
    trail: list[tuple] = []  # (impl_cls, new_local_id) for rollback, newest last
    try:
        for e in p_topo_order(manifest):
            cls = get_exportable(e.type)
            if cls is None:
                raise BundleError(f"can't import a {e.type.value} yet")
            new_id = cls.import_(p_read_payload(sandbox, e), p_read_files(sandbox, e), remap)
            remap.assign(e.bundle_id, new_id)
            created.setdefault(e.type.value, []).append(new_id)
            trail.append((cls, new_id))
    except Exception as ex:
        # All-or-nothing: undo whatever already landed so a failed import never leaves half a dashboard behind.
        for cls, nid in reversed(trail):
            rb = getattr(cls, "rollback", None)
            if rb:
                try:
                    rb(nid)
                except Exception:
                    pass
        if isinstance(ex, BundleError):
            raise
        raise BundleError("import failed and was rolled back")
    accepted = set(accept_requirements)
    unresolved = [r for r in manifest.requirements if r.key not in accepted]
    return manifest.root.type, remap.local(manifest.root.bundle_id), created, unresolved
