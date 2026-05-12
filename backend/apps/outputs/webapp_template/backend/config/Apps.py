from fastapi import FastAPI, APIRouter
from uuid import uuid4
from typing import List
from contextlib import asynccontextmanager
from contextlib import AsyncExitStack
from typing import Callable
from swarm_debug import debug
import os

class SubApp:
    def __init__(self, name:str, lifespan:Callable):
        debug("SubApp.__init__ START: %s", name)
        self.id = uuid4()
        self.name = name
        self.prefix = f"/api/{name}"
        self.lifespan = lifespan
        self.router = APIRouter()
        debug("SubApp.__init__ END")
    
    def __str__(self):
        return f"SubApp(name={self.name}, prefix={self.prefix}, id={self.id})"

class MainApp:
    def __init__(self, sub_apps: List[SubApp]):
        debug(" START")
        
        @asynccontextmanager
        async def lifespan(app: FastAPI):
            async with AsyncExitStack() as stack:
                for sub_app in sub_apps:
                    debug("Starting lifespan for sub_app: %s", sub_app.name)
                    await stack.enter_async_context(sub_app.lifespan())
                debug(f"Check out the API docs at: http://127.0.0.1:{os.environ.get('BACKEND_PORT', 8324)}/docs")
                yield
                
        self.app = FastAPI(lifespan=lifespan)
        
        for sub_app in sub_apps:
            self.app.include_router(
                sub_app.router, 
                prefix=sub_app.prefix,
                tags=[sub_app.name]
            )
        debug("END")