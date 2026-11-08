import { describe, expect, it } from "vitest";
import {
  CachedDictionary,
  FallbackDictionary,
  StdictHealth,
  type Dictionary,
  type KvLike,
  LocalDictionary,
  REASON_NOT_FOUND,
  REASON_NOT_NOUN,
  StdictClient,
  type Verdict,
} from "../src/dictionary";

type Handler = (url: URL) => Response | Promise<Response>;

function makeClient(handler: Handler): StdictClient {
  const fetchImpl = (async (input: RequestInfo | URL) => handler(new URL(String(input)))) as typeof fetch;
  return new StdictClient("test-key", fetchImpl);
}

const stdictResponse = (items: unknown[]) =>
  Response.json({ channel: { total: items.length, item: items } });

describe("StdictClient", () => {
  it("명사 표제어가 있으면 유효하다", async () => {
    let seen: URL | null = null;
    const client = makeClient((url) => {
      seen = url;
      return stdictResponse([{ word: "부산", pos: "명사", sense: {} }]);
    });
    expect(await client.isNoun("부산")).toEqual({ valid: true });
    expect(seen!.searchParams.get("q")).toBe("부산");
    expect(seen!.searchParams.get("key")).toBe("test-key");
    expect(seen!.searchParams.get("req_type")).toBe("json");
  });

  it("붙임표가 들어간 표제어도 매칭한다", async () => {
    const client = makeClient(() => stdictResponse([{ word: "부산-물", pos: "명사" }]));
    expect((await client.isNoun("부산물")).valid).toBe(true);
  });

  it("결과가 1건이면 객체로 와도 처리한다", async () => {
    const client = makeClient(() => Response.json({ channel: { total: 1, item: { word: "부산", pos: "명사" } } }));
    expect((await client.isNoun("부산")).valid).toBe(true);
  });

  it("명사가 아니면 거절한다 (대명사 포함)", async () => {
    const verb = makeClient(() => stdictResponse([{ word: "부르다", pos: "동사" }]));
    const v = await verb.isNoun("부르다");
    expect(v.valid).toBe(false);
    expect(v.reason).toBe(REASON_NOT_NOUN);
    const pronoun = makeClient(() => stdictResponse([{ word: "우리", pos: "대명사" }]));
    expect((await pronoun.isNoun("우리")).reason).toBe(REASON_NOT_NOUN);
  });

  it("없는 단어는 거절한다", async () => {
    const client = makeClient(() => Response.json({ channel: { total: 0 } }));
    const v = await client.isNoun("부끄끄");
    expect(v.valid).toBe(false);
    expect(v.reason).toBe(REASON_NOT_FOUND);
  });

  it("서버 오류·네트워크 오류는 error 판정이다", async () => {
    const server = makeClient(() => new Response("boom", { status: 500 }));
    expect((await server.isNoun("부산")).error).toBe(true);
    const network = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    expect((await network.isNoun("부산")).error).toBe(true);
  });
});

class CountingDictionary implements Dictionary {
  readonly name = "counting";
  calls = 0;
  constructor(private readonly verdict: Verdict) {}
  async isNoun(): Promise<Verdict> {
    this.calls += 1;
    return this.verdict;
  }
  promptSyllables(): null {
    return null;
  }
}

class FakeKv implements KvLike {
  readonly store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

describe("CachedDictionary", () => {
  it("메모리 캐시 히트는 내부 사전을 호출하지 않는다", async () => {
    const inner = new CountingDictionary({ valid: true });
    const cached = new CachedDictionary(inner, null);
    await cached.isNoun("부산");
    await cached.isNoun("부산");
    expect(inner.calls).toBe(1);
  });

  it("오류 판정은 캐시하지 않는다", async () => {
    const inner = new CountingDictionary({ valid: false, error: true, reason: "판정 불가" });
    const cached = new CachedDictionary(inner, null);
    await cached.isNoun("부산");
    await cached.isNoun("부산");
    expect(inner.calls).toBe(2);
  });

  it("KV 에 저장하고 새 인스턴스가 KV 에서 읽는다", async () => {
    const kv = new FakeKv();
    const first = new CachedDictionary(new CountingDictionary({ valid: false, reason: REASON_NOT_FOUND }), kv);
    await first.isNoun("부끄끄");
    expect(JSON.parse(kv.store.get("w:부끄끄")!).valid).toBe(false);

    const inner = new CountingDictionary({ valid: true });
    const second = new CachedDictionary(inner, kv);
    const v = await second.isNoun("부끄끄");
    expect(v.valid).toBe(false);
    expect(inner.calls).toBe(0);
  });

  it("KV 장애는 무시하고 내부 사전 결과를 돌려준다", async () => {
    const broken: KvLike = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    const cached = new CachedDictionary(new CountingDictionary({ valid: true }), broken);
    expect((await cached.isNoun("부산")).valid).toBe(true);
  });
});

describe("LocalDictionary", () => {
  it("텍스트에서 단어를 읽는다 (주석·공백 구분)", async () => {
    const local = LocalDictionary.fromText("# 주석\n부산 신문\n신발\n\n");
    expect((await local.isNoun("부산")).valid).toBe(true);
    expect((await local.isNoun("신문")).valid).toBe(true);
    expect((await local.isNoun("부자")).valid).toBe(false);
    expect(local.name).toBe("local");
  });

  it("길이별 제시어 음절을 계산한다", () => {
    const local = new LocalDictionary(new Set(["부산", "부모", "부동산", "신발", "신문", "신호등"]));
    expect(local.promptSyllables(2)).toEqual(new Set(["부", "신"]));
    expect(local.promptSyllables(3)).toEqual(new Set()); // 길이 3 단어가 음절당 1개뿐
    expect(local.promptSyllables(0)).toBeNull();
  });
});

describe("StdictClient 실패 진단", () => {
  it("빈 본문(HTTP 200, 키 오류 시 stdict 응답)은 error 판정이고 키를 로그에 남기지 않는다", async () => {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      const client = makeClient(() => new Response("", { status: 200, headers: { "content-type": "text/json" } }));
      const v = await client.isNoun("차례");
      expect(v.error).toBe(true);
      expect(logs.join("\n")).toContain("empty");
      expect(logs.join("\n")).not.toContain("test-key");
    } finally {
      console.warn = orig;
    }
  });
});

describe("FallbackDictionary", () => {
  const local = new LocalDictionary(new Set(["저녁", "저울"]));
  const failing = () => new CountingDictionary({ valid: false, error: true, reason: "판정 불가" });

  it("주 사전이 실패하면 로컬 사전으로 판정한다", async () => {
    const dict = new FallbackDictionary(failing(), local);
    expect(await dict.isNoun("저녁")).toEqual({ valid: true });
    expect((await dict.isNoun("저고리")).reason).toBe(REASON_NOT_FOUND);
    expect((await dict.isNoun("저고리")).error).toBeFalsy();
  });

  it("주 사전이 정상이면 그 결과를 그대로 쓴다", async () => {
    const dict = new FallbackDictionary(new CountingDictionary({ valid: true }), local);
    expect((await dict.isNoun("저고리")).valid).toBe(true);
    expect(dict.status).toBe("stdict");
  });

  it("폴백 판정은 KV 에 저장되지 않는다", async () => {
    const kv = new FakeKv();
    const dict = new FallbackDictionary(new CachedDictionary(failing(), kv), local);
    await dict.isNoun("저녁");
    expect(kv.store.size).toBe(0);
  });

  it("연속 실패하면 쿨다운 동안 주 사전을 건너뛰고, 지나면 다시 시도한다", async () => {
    let now = 0;
    const primary = failing();
    const dict = new FallbackDictionary(primary, local, { failureThreshold: 2, cooldownMs: 60_000, now: () => now });
    await dict.isNoun("저녁");
    await dict.isNoun("저녁");
    expect(primary.calls).toBe(2);
    expect(dict.status).toBe("stdict-degraded");
    await dict.isNoun("저녁");
    now = 59_999;
    await dict.isNoun("저녁");
    expect(primary.calls).toBe(2); // 열린 동안 호출 안 함
    now = 60_000;
    await dict.isNoun("저녁");
    expect(primary.calls).toBe(3); // 반열림 재시도
  });

  it("성공하면 실패 횟수와 차단 상태가 초기화된다", async () => {
    let now = 0;
    const verdicts: Verdict[] = [{ valid: false, error: true }, { valid: true }, { valid: false, error: true }];
    const primary: Dictionary = { name: "seq", isNoun: async () => verdicts.shift()!, promptSyllables: () => null };
    const dict = new FallbackDictionary(primary, local, { failureThreshold: 2, now: () => now });
    await dict.isNoun("저녁");
    await dict.isNoun("저녁");
    await dict.isNoun("저녁");
    expect(dict.status).toBe("stdict"); // 연속이 아니므로 열리지 않음
  });

  it("차단 중에는 로컬 사전의 제시어 음절을 쓴다", async () => {
    const dict = new FallbackDictionary(failing(), local, { failureThreshold: 1 });
    expect(dict.promptSyllables(2)).toBeNull();
    await dict.isNoun("저녁");
    expect(dict.promptSyllables(2)).toEqual(new Set(["저"]));
  });
});

describe("StdictHealth", () => {
  it("탐침 결과를 TTL 동안 캐시하고 실패면 degraded 를 보고한다", async () => {
    let now = 0;
    let ok = false;
    let calls = 0;
    const client: Dictionary = {
      name: "stdict",
      isNoun: async () => {
        calls += 1;
        return ok ? { valid: true } : { valid: false, error: true };
      },
      promptSyllables: () => null,
    };
    const health = new StdictHealth(client, 60_000, () => now);
    expect(await health.status()).toBe("stdict-degraded");
    ok = true;
    expect(await health.status()).toBe("stdict-degraded"); // 캐시
    expect(calls).toBe(1);
    now = 60_000;
    expect(await health.status()).toBe("stdict");
    expect(calls).toBe(2);
  });
});
