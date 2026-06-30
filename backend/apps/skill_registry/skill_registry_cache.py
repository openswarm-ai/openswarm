import json
import logging
import os

logger = logging.getLogger(__name__)

# Catalog ships in the repo so a brand-new install shows skills with zero network (build snapshot), and every successful live fetch is persisted to the user's cache so subsequent launches are instant + offline-safe. The live fetch always overwrites both once it lands, so neither can go stale at runtime.
BUNDLED_SNAPSHOT = os.path.join(os.path.dirname(__file__), "skills_snapshot.json")


def disk_cache_path() -> str:
    base = os.environ.get("OPENSWARM_SKILL_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache"
    )
    return os.path.join(base, "skill_registry.json")


def load_seed_cache() -> dict[str, dict]:
    """Return a non-empty catalog from the on-disk last-good cache, falling back
    to the bundled snapshot, so the registry is never empty on a cold/offline
    start. Returns {} only if neither source is present/valid."""
    for path in (disk_cache_path(), BUNDLED_SNAPSHOT):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                logger.info(f"Skill registry: seeded {len(data)} skills from {os.path.basename(path)}")
                return data
        except (OSError, ValueError):
            continue
    return {}


def save_disk_cache(skills: dict[str, dict]) -> None:
    """Persist the last good live fetch so the next launch is instant. Atomic
    replace so a crash mid-write can't leave a truncated cache."""
    if not skills:
        return
    path = disk_cache_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(skills, f)
        os.replace(tmp, path)
    except OSError:
        logger.debug("Skill registry: could not persist disk cache", exc_info=True)
