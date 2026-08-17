"""No-op shim: generated workspaces import the desktop's injected debugger; hosted runs have no
debugger to talk to, so every hook is a silent pass-through (call-style and decorator-style)."""


def debug(*args, **kwargs):
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]
    return None


def log(*args, **kwargs):
    return None


def snapshot(*args, **kwargs):
    return None
