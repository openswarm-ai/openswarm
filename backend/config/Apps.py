import os
import time

from fastapi import FastAPI, APIRouter
import debug
from uuid import uuid4
from typing import List
from contextlib import asynccontextmanager
from contextlib import AsyncExitStack
from typing import Callable


class SubApp:
    def __init__(self, name:str, lifespan:Callable):
        debug("START", name)
        self.id = uuid4()
        self.name = name
        self.prefix = f"/api/{name}"
        self.lifespan = lifespan
        self.router = APIRouter()
        debug("END")
    
    def __str__(self):
        return f"SubApp(name={self.name}, prefix={self.prefix}, id={self.id})"

class MainApp:
    def __init__(self, sub_apps: List[SubApp]):
        debug("START")
        
        @asynccontextmanager
        async def lifespan(app: FastAPI):
            async with AsyncExitStack() as stack:
                # [perf] per-lifespan boot timing. debug() is a no-op in the packaged build, so without this the packaged backend.log has no per-SubApp markers and a cold-start stall can only be guessed at. One perf_counter + flushed print per app pins exactly which lifespan (or the cold first-touch I/O entering it) dominates.
                p_boot_t0 = time.perf_counter()
                for sub_app in sub_apps:
                    debug(sub_app.name)
                    p_t0 = time.perf_counter()
                    await stack.enter_async_context(sub_app.lifespan())
                    p_dt = (time.perf_counter() - p_t0) * 1000
                    if p_dt > 50:  # only flag a slow lifespan; keeps boot logs quiet
                        print(f"[perf] lifespan {sub_app.name} t={p_dt:.0f}ms", flush=True)
                print(f"[perf] lifespans-total t={(time.perf_counter() - p_boot_t0) * 1000:.0f}ms", flush=True)
                p_port = os.environ.get("OPENSWARM_PORT", "8324")
                print(f"\nCheck out the API docs at: http://127.0.0.1:{p_port}/docs\n")
                yield
                
        self.app = FastAPI(lifespan=lifespan)

        for sub_app in sub_apps:
            self.app.include_router(
                sub_app.router, 
                prefix=sub_app.prefix,
                tags=[sub_app.name]
            )
        debug("END")