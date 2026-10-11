"""FastAPI 앱 조립: 정적 클라이언트, WebSocket, 헬스체크, 방 정리 작업."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR, Settings, load_settings
from .dictionary import CachedDictionary, Dictionary, build_dictionary
from .manager import RoomManager
from .ws import Hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

STATIC_DIR = BASE_DIR / "static"


def create_app(settings: Settings | None = None, dictionary: Dictionary | None = None) -> FastAPI:
    settings = settings or load_settings()
    dictionary = dictionary or build_dictionary(settings)
    manager = RoomManager(settings, dictionary)
    hub = Hub(manager)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def sweeper():
            while True:
                await asyncio.sleep(60)
                removed = manager.sweep()
                if removed:
                    logging.getLogger(__name__).info("빈 방 %d개 정리", removed)

        task = asyncio.ensure_future(sweeper())
        try:
            yield
        finally:
            task.cancel()
            if isinstance(dictionary, CachedDictionary):
                dictionary.save()

    app = FastAPI(title="첫글자 배틀", lifespan=lifespan)
    app.state.manager = manager
    app.state.settings = settings

    @app.get("/")
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "rooms": len(manager.rooms), "dictionary": dictionary.name}

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await hub.handle(ws)

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
