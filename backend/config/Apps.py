import os

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware 
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
                for sub_app in sub_apps:
                    debug(sub_app.name)
                    await stack.enter_async_context(sub_app.lifespan())
                _port = os.environ.get("OPENSWARM_PORT", "8324")
                print(f"\nCheck out the API docs at: http://127.0.0.1:{_port}/docs\n")
                yield
                
        self.app = FastAPI(lifespan=lifespan)
        self.app.add_middleware(
            CORSMiddleware , 
            allow_origins = ["http://localhost:3000"] , 
            allow_credentials=True , 
            allow_methods=["*"],
            allow_headers=["*"], 
        )

        for sub_app in sub_apps:
            self.app.include_router(
                sub_app.router, 
                prefix=sub_app.prefix,
                tags=[sub_app.name]
            )
        debug("END")