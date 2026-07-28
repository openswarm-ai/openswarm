"""Instant wake for file triggers on macOS/BSD: a kqueue vnode watch on the
directory fires the moment an entry is created, renamed, or deleted, and the
callback just marks the trigger due so the normal diff-based poll runs
immediately. The diff stays the source of truth (kqueue is only a wake
signal), the heartbeat poll stays as the fallback, and platforms without
kqueue simply keep polling. Content edits inside existing files don't touch
the directory vnode, so those still ride the heartbeat."""

import logging
import os
import select
from typing import Callable, Optional

logger = logging.getLogger(__name__)


def start_file_signal(path: str, on_change: Callable[[], None]) -> Optional[Callable[[], None]]:
    """Returns a stop() when a kqueue watch was installed, None when unsupported."""
    if not hasattr(select, "kqueue"):
        return None
    target = os.path.expanduser(path.strip())
    if not target or not os.path.exists(target):
        return None
    try:
        import asyncio

        loop = asyncio.get_running_loop()
        open_flags = getattr(os, "O_EVTONLY", os.O_RDONLY)
        fd = os.open(target, open_flags)
        kq = select.kqueue()
        fflags = (
            select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND | select.KQ_NOTE_ATTRIB
            | select.KQ_NOTE_RENAME | select.KQ_NOTE_DELETE
        )
        event = select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                              flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR, fflags=fflags)
        kq.control([event], 0)

        def p_on_readable() -> None:
            try:
                kq.control(None, 16, 0)  # drain whatever accumulated; one wake is enough
            except OSError:
                return
            on_change()

        loop.add_reader(kq.fileno(), p_on_readable)

        def stop() -> None:
            try:
                loop.remove_reader(kq.fileno())
            except Exception:
                pass
            try:
                kq.close()
            except OSError:
                pass
            try:
                os.close(fd)
            except OSError:
                pass

        return stop
    except Exception as e:
        logger.debug("file signal unavailable for %s: %s", path, e)
        return None
