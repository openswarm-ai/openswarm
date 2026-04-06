from typeguard import typechecked


# TODO: type spec this entirely
@typechecked
def forward_output(pipe) -> None:
    try:
        for line in iter(pipe.readline, b""):
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                print(f"[9router] {text}", flush=True)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass
