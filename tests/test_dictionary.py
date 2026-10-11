import json

import httpx
import pytest

from app.dictionary import CachedDictionary, LocalDictionary, StdictClient, Verdict


def make_client(handler) -> StdictClient:
    transport = httpx.MockTransport(handler)
    return StdictClient(api_key="test-key", client=httpx.AsyncClient(transport=transport))


def stdict_response(items, total=None):
    return httpx.Response(
        200,
        json={"channel": {"total": len(items) if total is None else total, "item": items}},
    )


async def test_noun_found_is_valid():
    seen = {}

    def handler(request: httpx.Request):
        seen["params"] = dict(request.url.params)
        return stdict_response([{"word": "부산", "pos": "명사", "sense": {"definition": "..."}}])

    verdict = await make_client(handler).is_noun("부산")
    assert verdict == Verdict(valid=True)
    assert seen["params"]["q"] == "부산"
    assert seen["params"]["key"] == "test-key"
    assert seen["params"]["req_type"] == "json"


async def test_hyphenated_headword_matches():
    def handler(request):
        return stdict_response([{"word": "부산-물", "pos": "명사", "sense": {}}])

    assert (await make_client(handler).is_noun("부산물")).valid


async def test_non_noun_only_is_invalid():
    def handler(request):
        return stdict_response([{"word": "부르다", "pos": "동사", "sense": {}}])

    verdict = await make_client(handler).is_noun("부르다")
    assert not verdict.valid and verdict.reason == "명사가 아닙니다"


async def test_not_found_is_invalid():
    def handler(request):
        return httpx.Response(200, json={"channel": {"total": 0}})

    verdict = await make_client(handler).is_noun("부끄끄")
    assert not verdict.valid and verdict.reason == "사전에 없는 단어입니다"


async def test_server_error_is_error_verdict():
    def handler(request):
        return httpx.Response(500, text="boom")

    verdict = await make_client(handler).is_noun("부산")
    assert verdict.error and not verdict.valid


async def test_timeout_is_error_verdict():
    def handler(request):
        raise httpx.ReadTimeout("slow")

    verdict = await make_client(handler).is_noun("부산")
    assert verdict.error


class CountingDictionary:
    name = "counting"

    def __init__(self, verdict: Verdict):
        self.verdict = verdict
        self.calls = 0

    async def is_noun(self, word: str) -> Verdict:
        self.calls += 1
        return self.verdict


async def test_cache_hits_skip_inner():
    inner = CountingDictionary(Verdict(valid=True))
    cached = CachedDictionary(inner, path=None)
    await cached.is_noun("부산")
    await cached.is_noun("부산")
    assert inner.calls == 1


async def test_cache_does_not_store_errors():
    inner = CountingDictionary(Verdict(valid=False, error=True, reason="판정 불가"))
    cached = CachedDictionary(inner, path=None)
    await cached.is_noun("부산")
    await cached.is_noun("부산")
    assert inner.calls == 2


async def test_cache_persists_to_file(tmp_path):
    path = tmp_path / "cache.json"
    inner = CountingDictionary(Verdict(valid=False, reason="사전에 없는 단어입니다"))
    cached = CachedDictionary(inner, path=path)
    await cached.is_noun("부끄끄")
    cached.save()
    assert json.loads(path.read_text(encoding="utf-8"))["부끄끄"]["valid"] is False

    reloaded = CachedDictionary(CountingDictionary(Verdict(valid=True)), path=path)
    verdict = await reloaded.is_noun("부끄끄")
    assert not verdict.valid and reloaded.inner.calls == 0


async def test_local_dictionary(tmp_path):
    f = tmp_path / "words.txt"
    f.write_text("# 주석\n부산 신문\n신발\n\n", encoding="utf-8")
    local = LocalDictionary.from_file(f)
    assert (await local.is_noun("부산")).valid
    assert (await local.is_noun("신문")).valid
    assert not (await local.is_noun("부자")).valid
    assert local.name == "local"


async def test_local_prompt_syllables_by_length():
    local = LocalDictionary({"부산", "부모", "부동산", "신발", "신문", "신호등"})
    assert local.prompt_syllables(2) == {"부", "신"}
    assert local.prompt_syllables(3) == set()  # 길이 3 단어가 음절당 1개뿐
    assert local.prompt_syllables(0) is None
