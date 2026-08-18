import ntpath
import os
import posixpath
import re
import sys
from urllib.parse import unquote


P_PATH_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
P_WINDOWS_DEVICE_NAMES = {
    "AUX", "CON", "NUL", "PRN",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def p_decoded_path_value(value: str) -> str:
    """Decode nested URL escaping so encoded separators cannot hide in IDs."""
    decoded = value
    for _ in range(8):
        next_value = unquote(decoded)
        if next_value == decoded:
            return decoded
        decoded = next_value
    raise ValueError("path identifier is excessively encoded")


def p_validate_path_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    decoded = p_decoded_path_value(value)
    drive, _ = ntpath.splitdrive(decoded)
    if (
        decoded in {".", ".."}
        or "\x00" in decoded
        or "/" in decoded
        or "\\" in decoded
        or drive
        or posixpath.isabs(decoded)
        or ntpath.isabs(decoded)
        or P_PATH_ID_PATTERN.fullmatch(decoded) is None
        or decoded.upper() in P_WINDOWS_DEVICE_NAMES
    ):
        raise ValueError(f"invalid {label}")
    return value


def validate_output_id(value: str) -> str:
    return p_validate_path_id(value, "output ID")


def validate_workspace_id(value: str) -> str:
    return p_validate_path_id(value, "workspace ID")


def contained_path(root: str, *parts: str) -> str:
    """Join under root and reject component escapes and outward symlinks."""
    root_path = os.path.abspath(root)
    candidate = os.path.abspath(os.path.join(root_path, *parts))
    root_real = os.path.realpath(root_path)
    candidate_real = os.path.realpath(candidate)
    try:
        common = os.path.commonpath((root_real, candidate_real))
    except ValueError as exc:
        raise ValueError("path is outside configured root") from exc
    if os.path.normcase(common) != os.path.normcase(root_real):
        raise ValueError("path is outside configured root")
    return candidate


def opened_file_path(file_descriptor: int) -> str:
    """Return the final filesystem path bound to an already-open descriptor."""
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        get_final_path = ctypes.WinDLL(
            "kernel32", use_last_error=True
        ).GetFinalPathNameByHandleW
        get_final_path.argtypes = (
            wintypes.HANDLE,
            wintypes.LPWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
        )
        get_final_path.restype = wintypes.DWORD
        handle = wintypes.HANDLE(msvcrt.get_osfhandle(file_descriptor))
        buffer_size = 512
        while True:
            buffer = ctypes.create_unicode_buffer(buffer_size)
            length = get_final_path(handle, buffer, buffer_size, 0)
            if length == 0:
                raise ctypes.WinError(ctypes.get_last_error())
            if length < buffer_size:
                path = buffer.value
                break
            buffer_size = length + 1
        if path.startswith("\\\\?\\UNC\\"):
            return "\\\\" + path[8:]
        if path.startswith("\\\\?\\"):
            return path[4:]
        return path

    proc_descriptor = f"/proc/self/fd/{file_descriptor}"
    try:
        return os.path.realpath(proc_descriptor, strict=True)
    except OSError:
        if sys.platform != "darwin":
            raise

    import fcntl

    path_bytes = fcntl.fcntl(file_descriptor, 50, b"\0" * 1024)
    return os.fsdecode(path_bytes.split(b"\0", 1)[0])


def opened_file_is_contained(resolved_root: str, file_descriptor: int) -> bool:
    """Check containment using the final target of an open file handle."""
    root_path = os.path.abspath(resolved_root)
    opened_path = os.path.abspath(opened_file_path(file_descriptor))
    try:
        common = os.path.commonpath((root_path, opened_path))
    except ValueError:
        return False
    return os.path.normcase(common) == os.path.normcase(root_path)


def workspace_directory(root: str, workspace_id: str) -> str:
    validate_workspace_id(workspace_id)
    return contained_path(root, workspace_id)
