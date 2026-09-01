"""The packaged backend's entry point: `python -m backend.serve --port N`.

Why not `python -m uvicorn backend.main:app`: agents building FastAPI apps restart their own dev
server with `pkill -f "uvicorn backend.main"` (the app template is uvicorn + backend/main.py too),
and that pattern matched the OpenSwarm backend's own command line. Measured 2026-09-01 on a packaged
soak: one agent's restart command took down the host backend, a second instance's backend and the
user's production app backend, twelve seconds apart, twice. A command line that contains neither
"uvicorn" nor "backend.main" cannot be caught by the patterns an app-building agent reaches for.
"""
import argparse
import asyncio
import os
import uvicorn
from typeguard import typechecked


class ReadyServer(uvicorn.Server):
    """Prints a machine-readable READY line once the socket is bound, like the dev runner does."""
    async def startup(self, sockets=None):
        await super().startup(sockets)
        print(f"READY:PORT={self.config.port}", flush=True)


@typechecked
def main() -> None:
    parser = argparse.ArgumentParser(description="OpenSwarm backend server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENSWARM_PORT", "8324")))
    parser.add_argument("--host", default=os.environ.get("OPENSWARM_HOST", "127.0.0.1"))
    parser.add_argument("--timeout-graceful-shutdown", type=int, default=8)
    args = parser.parse_args()
    os.environ["OPENSWARM_PORT"] = str(args.port)
    config = uvicorn.Config("backend.main:app", host=args.host, port=args.port, timeout_graceful_shutdown=args.timeout_graceful_shutdown)
    asyncio.run(ReadyServer(config).serve())


if __name__ == "__main__":
    main()
