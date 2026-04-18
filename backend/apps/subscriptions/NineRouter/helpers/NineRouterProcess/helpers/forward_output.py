import re

from swarm_debug import debug
from typeguard import typechecked

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b[c78]")


# TODO: type spec this entirely
@typechecked
def forward_output(pipe) -> None:
    try:
        for line in iter(pipe.readline, b""):
            text = _ANSI_RE.sub("", line.decode("utf-8", errors="replace")).rstrip()
            if text:
                print(f"[9router] {text}", flush=True)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass
