"""Put the bundled agent runtime back when antivirus takes it, instead of asking the user to.

The failure: Windows AV quarantines `claude.exe` out of the installed app, every agent reply stops,
and the card tells the user to restore it from quarantine and add an exclusion. That is the correct
fix and almost nobody performs it -- 22 of 25 affected installs never produced another agent reply,
and a real user replied "don't know how to take a file out of quarantine" (ENG-422). Signing does not
prevent it: the release gates on the binary being validly signed and it is taken anyway.

The one link we control is that we cannot repair ourselves. We can: Squirrel keeps the installer
package on disk under the user's own app data, and that package contains a pristine copy. Restoring
is a local file copy with no download and no admin rights.

Deliberately NOT silent. A repair that hides itself is how "it broke, then it worked, then it broke"
becomes unreportable; the caller says what happened, and if AV takes it again immediately we say THAT
rather than looping.
"""

import logging
import os
import platform
import shutil
import time
import zipfile
from typing import List, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

logger = logging.getLogger(__name__)

# Long enough that a real-time scanner has had its chance, short enough that a user is still watching.
RETAKEN_CHECK_SECONDS = 2.0


class RepairResult(BaseModel):
    """What actually happened, in the caller's words. `repaired` alone is not enough: a file that
    comes back and is immediately re-quarantined must not read as a fix."""

    model_config = ConfigDict(validate_assignment=True)

    repaired: bool = False
    retaken: bool = False
    source: Optional[str] = None
    detail: str = ""


@typechecked
def package_cache_dirs() -> List[str]:
    """Where the installer package lives, per platform. Windows is the only place this class has
    been observed, but the search is written so a mac build can be repaired the same way if it ever
    needs to be."""
    p_out: List[str] = []
    if platform.system() == "Windows":
        for p_var in ("LOCALAPPDATA", "APPDATA"):
            p_base = os.environ.get(p_var)
            if p_base:
                p_out.append(os.path.join(p_base, "openswarm", "packages"))
    return [d for d in p_out if os.path.isdir(d)]


@typechecked
def find_pristine_copy(member_suffix: str, search_dirs: Optional[List[str]] = None) -> Optional[str]:
    """The newest installer package that actually contains the missing file.

    Newest first, because an older package holds an older binary and silently restoring THAT is how
    a version mismatch becomes a second, stranger bug."""
    p_dirs = package_cache_dirs() if search_dirs is None else search_dirs
    p_packages: List[str] = []
    for d in p_dirs:
        for name in os.listdir(d):
            if name.lower().endswith((".nupkg", ".zip")):
                p_packages.append(os.path.join(d, name))
    p_packages.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for pkg in p_packages:
        try:
            with zipfile.ZipFile(pkg) as z:
                for member in z.namelist():
                    if member.replace("\\", "/").endswith(member_suffix):
                        return pkg
        except Exception as e:
            logger.debug("self-heal: %s is not a readable package (%s)", pkg, e)
    return None


@typechecked
def repair_bundled_cli(dest: str, member_suffix: str = "_bundled/claude.exe",
                       search_dirs: Optional[List[str]] = None) -> RepairResult:
    """Restore `dest` from the installer package, then check it survived.

    Returns what happened rather than raising: a failed repair must leave the existing card standing,
    not replace a explainable problem with a traceback."""
    if os.path.isfile(dest):
        return RepairResult(detail="the runtime is already present; nothing to repair")
    pkg = find_pristine_copy(member_suffix, search_dirs)
    if pkg is None:
        return RepairResult(
            detail="no installer package on disk holds a copy, so this needs a reinstall")
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with zipfile.ZipFile(pkg) as z:
            member = next(m for m in z.namelist()
                          if m.replace("\\", "/").endswith(member_suffix))
            with z.open(member) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
        os.chmod(dest, 0o755)
    except Exception as e:
        logger.warning("self-heal: could not restore %s from %s (%s)", dest, pkg, e)
        return RepairResult(source=pkg, detail=f"restoring it failed: {e}")

    # The half that matters. A restore that is undone a second later is not a repair, and reporting
    # it as one sends the user back to a broken app believing it is fixed.
    time.sleep(RETAKEN_CHECK_SECONDS)
    if not os.path.isfile(dest):
        logger.warning("self-heal: %s was removed again right after restore; antivirus is holding it", dest)
        return RepairResult(repaired=True, retaken=True, source=pkg,
                            detail="it was restored and removed again straight away; turn on "
                                   "Settings, then Advanced, then Antivirus exclusion, or it will "
                                   "keep being removed")
    logger.info("self-heal: restored the bundled agent runtime from %s", pkg)
    return RepairResult(repaired=True, source=pkg,
                        detail="the bundled agent runtime was restored from your installer package")
