"""One asyncio primitive per event loop, so module-level state can never outlive the loop it used."""

import asyncio
from typing import Callable, Optional, TypeVar

T = TypeVar("T")


def loop_local(factory: Callable[[], T]) -> Callable[[], T]:
    """Wrap an asyncio primitive so it is rebuilt whenever the running event loop changes.

    A module-level ``asyncio.Lock()`` outlives the loop that used it. If that loop dies while the
    lock is HELD, the flag stays set forever and the next loop waits on a release that can never
    come: no error, no log line, just a process that stops. That is what wedged the entire backend
    test suite (ENG-219), and after a ``uvicorn --reload`` it is the same silent hang in the app.
    A Semaphore loses its count the same way; an Event raises "bound to a different event loop"
    and kills whatever loop was driving it.

    Pass the CLASS, not an instance, and call the result::

        p_boot_lock = loop_local(asyncio.Lock)

        async with p_boot_lock():
            ...

    Needs a running loop, which is the whole point: nothing else can say which loop to build for.
    """
    held: Optional[T] = None
    held_loop: Optional[asyncio.AbstractEventLoop] = None

    def get() -> T:
        nonlocal held, held_loop
        running = asyncio.get_running_loop()
        if held is None or held_loop is not running:
            held = factory()
            held_loop = running
        return held

    return get
