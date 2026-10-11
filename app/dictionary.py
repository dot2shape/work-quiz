"""단어 판정 계층.

- StdictClient     : 국립국어원 표준국어대사전 오픈 API 호출
- CachedDictionary : 메모리 + JSON 파일 캐시 (오류 결과는 캐시하지 않음)
- LocalDictionary  : 로컬 시드 단어 목록 (API 키가 없을 때 개발용)
"""
from __future__ import annotations

import json
import logging
from collections import OrderedDict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

import httpx

from .hangul import normalize

log = logging.getLogger(__name__)

STDICT_URL = "https://stdict.korean.go.kr/api/search.do"

REASON_NOT_FOUND = "사전에 없는 단어입니다"
REASON_NOT_NOUN = "명사가 아닙니다"
REASON_LOOKUP_FAILED = "사전 조회에 실패했습니다. 다시 제출해 주세요"


@dataclass(frozen=True)
class Verdict:
    valid: bool
    reason: str | None = None
    error: bool = False


class Dictionary(Protocol):
    name: str

    async def is_noun(self, word: str) -> Verdict: ...


class StdictClient:
    """표준국어대사전 오픈 API로 '명사 표제어' 존재 여부를 확인한다."""

    name = "stdict"

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None, timeout: float = 3.0):
        self._key = api_key
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def is_noun(self, word: str) -> Verdict:
        params = {
            "key": self._key,
            "q": word,
            "req_type": "json",
            "advanced": "y",
            "method": "exact",
            "type1": "word",  # 어휘만 (구·관용구·속담 제외)
            "num": "50",
        }
        try:
            resp = await self._client.get(STDICT_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("stdict 조회 실패 word=%s err=%r", word, exc)
            return Verdict(valid=False, reason=REASON_LOOKUP_FAILED, error=True)

        channel = data.get("channel") or {}
        items = channel.get("item") or []
        if isinstance(items, dict):  # 결과가 1건이면 객체로 오는 경우 대비
            items = [items]
        if not items:
            return Verdict(valid=False, reason=REASON_NOT_FOUND)

        matched = [it for it in items if normalize(str(it.get("word", ""))) == word]
        if not matched:
            return Verdict(valid=False, reason=REASON_NOT_FOUND)
        if any("명사" in str(it.get("pos", "")) and "대명사" not in str(it.get("pos", "")) for it in matched):
            return Verdict(valid=True)
        return Verdict(valid=False, reason=REASON_NOT_NOUN)

    async def aclose(self) -> None:
        await self._client.aclose()


class CachedDictionary:
    """내부 사전 결과를 메모리에 캐시하고 선택적으로 JSON 파일에 저장한다."""

    def __init__(self, inner: Dictionary, path: Path | None, max_size: int = 50_000):
        self.inner = inner
        self.name = inner.name
        self._path = path
        self._max = max_size
        self._cache: OrderedDict[str, Verdict] = OrderedDict()
        self._dirty = 0
        if path is not None and path.exists():
            self._load(path)

    def _load(self, path: Path) -> None:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("캐시 파일 로드 실패 %s: %r", path, exc)
            return
        for word, v in raw.items():
            self._cache[word] = Verdict(valid=bool(v.get("valid")), reason=v.get("reason"))

    async def is_noun(self, word: str) -> Verdict:
        hit = self._cache.get(word)
        if hit is not None:
            self._cache.move_to_end(word)
            return hit
        verdict = await self.inner.is_noun(word)
        if not verdict.error:
            self._cache[word] = verdict
            while len(self._cache) > self._max:
                self._cache.popitem(last=False)
            self._dirty += 1
            if self._dirty >= 20:
                self.save()
        return verdict

    def save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {w: {"valid": v.valid, "reason": v.reason} for w, v in self._cache.items()}
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
            self._dirty = 0
        except OSError as exc:
            log.warning("캐시 저장 실패 %s: %r", self._path, exc)

    def __len__(self) -> int:
        return len(self._cache)


class LocalDictionary:
    """시드 단어 목록으로만 판정한다. API 키가 없는 개발 환경용."""

    name = "local"

    def __init__(self, words: set[str]):
        self._words = words

    @classmethod
    def from_file(cls, path: Path) -> "LocalDictionary":
        words: set[str] = set()
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            for token in line.split():  # 한 줄에 여러 단어를 공백으로 나열할 수 있다
                words.add(normalize(token))
        return cls(words)

    async def is_noun(self, word: str) -> Verdict:
        if word in self._words:
            return Verdict(valid=True)
        return Verdict(valid=False, reason=REASON_NOT_FOUND)


def build_dictionary(settings) -> Dictionary:
    """설정에 따라 사전 구현을 조립한다. 키가 있으면 API+캐시, 없으면 로컬 사전."""
    if settings.stdict_api_key:
        return CachedDictionary(StdictClient(settings.stdict_api_key), path=settings.cache_path)
    log.warning("STDICT_API_KEY가 없어 로컬 사전 모드로 동작합니다 (%s)", settings.seed_words_path)
    return LocalDictionary.from_file(settings.seed_words_path)
