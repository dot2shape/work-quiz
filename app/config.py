"""환경변수 기반 설정. 키는 .env 또는 실제 환경변수로만 들어온다."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    stdict_api_key: str | None = None
    port: int = 5020
    target_score: int = 5
    round_seconds: int = 20
    countdown_seconds: int = 3
    round_end_seconds: int = 3
    cooldown_seconds: float = 1.0
    max_players: int = 8
    min_players: int = 2
    max_rooms: int = 200
    empty_room_ttl_seconds: int = 600
    cache_path: Path = BASE_DIR / "data" / "dict_cache.json"
    seed_words_path: Path = BASE_DIR / "data" / "seed_words.txt"


def load_settings() -> Settings:
    load_dotenv(BASE_DIR / ".env")
    key = os.environ.get("STDICT_API_KEY", "").strip() or None
    return Settings(
        stdict_api_key=key,
        port=int(os.environ.get("PORT", "5020")),
        target_score=int(os.environ.get("TARGET_SCORE", "5")),
        round_seconds=int(os.environ.get("ROUND_SECONDS", "20")),
    )
