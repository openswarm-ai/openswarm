"""Which kind of machine wrote a diagnostic: OS, chip, cores, memory. Every field report used to come
from "a Mac", and every timing verdict from one developer's M-series; the fleet spans a 2017 iMac and
Windows laptops nobody has measured, so the envelope says what it ran on."""
from __future__ import annotations

import ctypes
import functools
import os
import platform
import sys


def p_memory_bytes() -> int | None:
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        return int(status.ullTotalPhys) if kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        return None


def p_os_version() -> str:
    # Darwin's kernel number (25.6.0) means nothing to a reader; the marketing version does.
    if sys.platform == "darwin":
        return platform.mac_ver()[0] or platform.release()
    if sys.platform == "win32":
        return platform.version()
    return platform.release()


@functools.lru_cache(maxsize=1)
def machine_facts() -> dict[str, object]:
    memory = p_memory_bytes()
    return {
        "os": platform.system(),
        "os_version": p_os_version(),
        "arch": platform.machine(),
        "cpus": os.cpu_count() or 0,
        "memory_gb": round(memory / 1024**3, 1) if memory else None,
    }
