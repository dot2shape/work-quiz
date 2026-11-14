import { describe, expect, it } from "vitest";
import {
  BlocklistDictionary,
  CachedDictionary,
  CircuitBreaker,
  type Dictionary,
  FallbackDictionary,
  type KvLike,
  LocalDictionary,
  REASON_BANNED,
  REASON_NOT_FOUND,
  StdictClient,
  TieredDictionary,
  type Verdict,
} from "../src/dictionary";
import type { Picker } from "../src/prompts";
import { CancelledError, type Message, Room, type Sleep } from "../src/room";
import { DEFAULT_SETTINGS } from "../src/settings";

class Scripted implements Dictionary {
  calls: string[] = [];
  constructor(
    readonly name: string,
    private readonly answer: (word: string) => Verdict,
    private readonly pool: Set<string> | null = null,
  ) {}
  async isNoun(word: string): Promise<Verdict> {
    this.calls.push(word);
    return this.answer(word);
  }
  promptSyllables(): Set<string> | null {
    return this.pool;
  }
}

/** expirationTtl 을 흉내 내는 KV 대역. */
class TtlKv implements KvLike {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  readonly puts: Array<{ key: string; ttl?: number }> = [];
  constructor(private readonly now: () => number) {}
  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key);
    if (!hit || hit.expiresAt <= this.now()) return null;
    return hit.value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, ttl: options?.expirationTtl });
    const ttlMs = options?.expirationTtl ? options.expirationTtl * 1000 : Number.POSITIVE_INFINITY;
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

const failing = () => new Scripted("stdict", () => ({ valid: false, error: true, reason: "판정 불가" }));
const stdictOk = (items: unknown[]) =>
  new StdictClient("test-key", (async () => Response.json({ channel: { item: items } })) as typeof fetch);

describe("BlocklistDictionary (차단 층)", () => {
  const banned = new Set(["바보"]);

  it("차단 단어는 안쪽 사전을 부르지 않고 '사용할 수 없는 단어입니다'로 거절한다", async () => {
    const inner = new Scripted("local", () => ({ valid: true }));
    const dict = new BlocklistDictionary(inner, banned);
    const v = await dict.isNoun("바보");
    expect(v).toEqual({ valid: false, reason: REASON_BANNED });
    expect(REASON_BANNED).toBe("사용할 수 없는 단어입니다");
    expect(v.error).toBeFalsy(); // 쿨다운 대상(오류가 아님)
    expect(inner.calls).toEqual([]);
  });

  it("stdict 가 명사로 인정하는 단어여도 차단한다", async () => {
    const dict = new BlocklistDictionary(stdictOk([{ word: "바보", pos: "명사" }]), banned);
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED);
  });

  it("시드(local) 사전에 있는 단어여도 차단한다", async () => {
    const dict = new BlocklistDictionary(new LocalDictionary(new Set(["바보", "바다"])), banned);
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED);
    expect(await dict.isNoun("바다")).toEqual({ valid: true });
  });

  it("차단 목록에 없으면 안쪽 사전 결과·이름·제시어 집합을 그대로 쓴다", async () => {
    const inner = new Scripted("stdict", () => ({ valid: false, reason: REASON_NOT_FOUND }), new Set(["바"]));
    const dict = new BlocklistDictionary(inner, banned);
    expect((await dict.isNoun("바뷁")).reason).toBe(REASON_NOT_FOUND);
    expect(dict.name).toBe("stdict");
    expect(dict.promptSyllables(2)).toEqual(new Set(["바"]));
  });
});

describe("차단 거절은 쿨다운 대상이다 (Room)", () => {
  const fastSleep: Sleep = (seconds, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), seconds * 10);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(new CancelledError())), { once: true });
    });
  const picker: Picker = { next: () => "바" };

  it("차단 단어를 내면 사유와 함께 쿨다운이 걸린다", async () => {
    const sent: Array<[string, Message]> = [];
    const dict = new BlocklistDictionary(new LocalDictionary(new Set(["바보", "바다"])), new Set(["바보"]));
    const room = new Room("ABCDEF", dict, DEFAULT_SETTINGS, async () => {}, async (pid, m) => void sent.push([pid, m]), {
      picker,
      sleep: fastSleep,
    });
    const a = room.addPlayer("철수");
    room.addPlayer("영희");
    await room.start(a.id);
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 2));
    await room.submit(a.id, "바보");
    await new Promise((r) => setTimeout(r, 10));
    const result = sent.filter(([pid, m]) => pid === a.id && m.type === "submit_result").at(-1)![1];
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe(REASON_BANNED);
    expect(Number(result.cooldown_ms)).toBeGreaterThan(0);
    room.close();
  });
});

describe("CachedDictionary.peek", () => {
  it("캐시에 있으면 돌려주고, 없으면 안쪽 사전을 부르지 않고 null 을 돌려준다", async () => {
    const kv = new TtlKv(() => 0);
    await kv.put("w:저고리", JSON.stringify({ valid: true, reason: null }));
    const inner = failing();
    const cached = new CachedDictionary(inner, kv);
    expect((await cached.peek("저고리"))?.valid).toBe(true);
    expect(await cached.peek("저승")).toBeNull();
    expect(inner.calls).toEqual([]);
  });
});

describe("CircuitBreaker", () => {
  it("연속 실패로 열리고, 쿨다운이 지나면 다시 시도하게 하며, 성공하면 닫힌다", () => {
    let now = 0;
    const b = new CircuitBreaker(2, 1000, () => now);
    expect(b.failure()).toBeNull();
    expect(b.open).toBe(false);
    expect(b.failure()).toBe(1000);
    expect(b.open).toBe(true);
    now = 1000;
    expect(b.open).toBe(false); // 반열림: 한 번 더 시도
    expect(b.tripped).toBe(true);
    b.success();
    expect(b.tripped).toBe(false);
  });
});

describe("FallbackDictionary — 차단 중 캐시 우선 (#18)", () => {
  const local = new LocalDictionary(new Set(["저녁", "저울"]));

  it("브레이커가 열려 있어도 KV 에 캐시된 stdict 판정을 먼저 쓰고, 없을 때만 시드로 판정한다", async () => {
    const kv = new TtlKv(() => 0);
    await kv.put("w:저고리", JSON.stringify({ valid: true, reason: null })); // 예전에 stdict 가 인정한 단어
    await kv.put("w:저녁", JSON.stringify({ valid: false, reason: "명사가 아닙니다" })); // 캐시가 시드보다 우선
    const inner = failing();
    const dict = new FallbackDictionary(new CachedDictionary(inner, kv), local, { failureThreshold: 1 });
    await dict.isNoun("저울"); // 실패 1회 → 열림
    expect(dict.status).toBe("stdict-degraded");
    const before = inner.calls.length;

    expect(await dict.isNoun("저고리")).toMatchObject({ valid: true }); // 시드에 없지만 캐시에 있다
    expect((await dict.isNoun("저녁")).valid).toBe(false);
    expect(await dict.isNoun("저울")).toEqual({ valid: true }); // 캐시에 없으면 시드
    expect(inner.calls.length).toBe(before); // 열린 동안 stdict 호출 없음
  });
});

describe("FallbackDictionary — 방 간 브레이커 공유 (#18)", () => {
  const local = new LocalDictionary(new Set(["저녁", "저울"]));

  it("한 방에서 열리면 KV 플래그를 남기고, 새 방은 실패를 다시 겪지 않는다", async () => {
    let now = 1_000_000;
    const kv = new TtlKv(() => now);
    const opts = { failureThreshold: 2, cooldownMs: 60_000, now: () => now, shared: kv };

    const primaryA = failing();
    const roomA = new FallbackDictionary(primaryA, local, opts);
    await roomA.isNoun("저녁");
    await roomA.isNoun("저녁");
    expect(roomA.status).toBe("stdict-degraded");
    const flag = kv.puts.find((p) => p.key === "breaker:stdict");
    expect(flag?.ttl).toBeGreaterThanOrEqual(60); // KV 최소 TTL

    const primaryB = failing();
    const roomB = new FallbackDictionary(primaryB, local, opts);
    await roomB.syncShared(); // DO 초기화 때 호출
    expect(roomB.status).toBe("stdict-degraded");
    expect(roomB.promptSyllables(2)).toEqual(new Set(["저"])); // 첫 라운드부터 시드 음절로 제한
    expect(await roomB.isNoun("저녁")).toEqual({ valid: true });
    expect(primaryB.calls).toEqual([]);

    now += 60_000; // 쿨다운 경과 → 다시 시도
    await roomB.isNoun("저녁");
    expect(primaryB.calls.length).toBe(1);
  });

  it("이미 떠 있는 방도 주기적으로 플래그를 확인한다", async () => {
    let now = 1_000_000;
    const kv = new TtlKv(() => now);
    const opts = { failureThreshold: 2, cooldownMs: 60_000, now: () => now, shared: kv, sharedCheckMs: 30_000 };
    const primaryB = new Scripted("stdict", () => ({ valid: true }));
    const roomB = new FallbackDictionary(primaryB, local, opts);
    await roomB.isNoun("저고리"); // 정상 — 이때 플래그 없음
    expect(primaryB.calls.length).toBe(1);

    const roomA = new FallbackDictionary(failing(), local, opts);
    await roomA.isNoun("저녁");
    await roomA.isNoun("저녁"); // 열림 → 플래그

    now += 30_000;
    expect(await roomB.isNoun("저승")).toMatchObject({ valid: false, reason: REASON_NOT_FOUND }); // 시드 판정
    expect(primaryB.calls.length).toBe(1);
  });

  it("KV 장애는 무시한다", async () => {
    const broken: KvLike = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    const dict = new FallbackDictionary(failing(), local, { failureThreshold: 1, shared: broken });
    await dict.syncShared();
    expect(await dict.isNoun("저녁")).toEqual({ valid: true });
    expect(dict.status).toBe("stdict-degraded");
  });
});

describe("StdictClient 실패 로그 마스킹 (#18)", () => {
  async function logsFor(body: string): Promise<string> {
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      const client = new StdictClient("SECRETKEY1234567890", (async () => new Response(body, { status: 500 })) as typeof fetch);
      expect((await client.isNoun("차례")).error).toBe(true);
    } finally {
      console.warn = orig;
    }
    return logs.join("\n");
  }

  it("응답 본문에 요청 URL(key=...)이 되돌아와도 키를 남기지 않는다", async () => {
    const out = await logsFor("<error>bad request: /api/search.do?key=SECRETKEY1234567890&q=x</error>");
    expect(out).not.toContain("SECRETKEY");
    expect(out).toContain("key=***");
    expect(out).toContain("bad request"); // 진단에 필요한 나머지는 남는다
  });

  it("key= 없이 키 값만 나오거나 120자 경계에 걸쳐도 남기지 않는다", async () => {
    const out = await logsFor(`${"x".repeat(110)}SECRETKEY1234567890 tail`);
    expect(out).not.toContain("SECRETKEY");
    const other = await logsFor(`${"y".repeat(100)} certkey=ABCDEFGHIJKLMNOPQRSTUVWXYZ&`);
    expect(other).not.toContain("ABCDEFGH");
  });
});

describe("TieredDictionary (D1 → 기존 경로)", () => {
  const primaryOf = (words: Record<string, Verdict>, pool: Set<string> | null = null) =>
    new Scripted("d1", (w) => words[w] ?? { valid: false, reason: REASON_NOT_FOUND }, pool);

  it("주 사전이 인정하면 그대로 인정하고 다음 사전을 부르지 않는다", async () => {
    const secondary = new Scripted("stdict", () => ({ valid: false, reason: REASON_NOT_FOUND }));
    const dict = new TieredDictionary(primaryOf({ 갓생: { valid: true } }), secondary);
    expect(await dict.isNoun("갓생")).toEqual({ valid: true });
    expect(secondary.calls).toEqual([]);
    expect(dict.name).toBe("d1");
  });

  it("주 사전에 없으면 다음 사전(stdict → 시드)으로 판정한다", async () => {
    const secondary = new Scripted("stdict", (w) => (w === "가방" ? { valid: true } : { valid: false, reason: REASON_NOT_FOUND }));
    const dict = new TieredDictionary(primaryOf({}), secondary);
    expect(await dict.isNoun("가방")).toEqual({ valid: true });
    expect((await dict.isNoun("가뷁")).reason).toBe(REASON_NOT_FOUND);
  });

  it("주 사전의 차단 판정은 다음 사전으로 넘기지 않는다", async () => {
    const secondary = new Scripted("stdict", () => ({ valid: true }));
    const dict = new TieredDictionary(primaryOf({ 바보: { valid: false, reason: REASON_BANNED } }), secondary);
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED);
    expect(secondary.calls).toEqual([]);
  });

  it("주 사전 조회 오류는 다음 사전으로 판정하고, 연속 오류면 잠시 건너뛴다", async () => {
    let now = 0;
    const primary = new Scripted("d1", () => ({ valid: false, error: true, reason: "조회 실패" }));
    const secondary = new Scripted("local", (w) => (w === "가방" ? { valid: true } : { valid: false, reason: REASON_NOT_FOUND }));
    const dict = new TieredDictionary(primary, secondary, { breaker: new CircuitBreaker(2, 60_000, () => now) });
    expect(await dict.isNoun("가방")).toEqual({ valid: true });
    expect((await dict.isNoun("가뷁")).error).toBeFalsy(); // 오류가 플레이어에게 새지 않는다
    expect(primary.calls.length).toBe(2);
    await dict.isNoun("가방");
    expect(primary.calls.length).toBe(2); // 열림
    now = 60_000;
    await dict.isNoun("가방");
    expect(primary.calls.length).toBe(3);
  });

  it("strict 면 주 사전에 없는 단어를 바로 거절하되, 조회 오류는 여전히 다음 사전으로 넘긴다", async () => {
    const secondary = new Scripted("stdict", () => ({ valid: true }));
    const strict = new TieredDictionary(primaryOf({}), secondary, { strict: true });
    expect((await strict.isNoun("가방")).reason).toBe(REASON_NOT_FOUND);
    expect(secondary.calls).toEqual([]);
    const broken = new TieredDictionary(new Scripted("d1", () => ({ valid: false, error: true })), secondary, { strict: true });
    expect(await broken.isNoun("가방")).toEqual({ valid: true });
  });

  it("제시어 집합: 다음 사전이 '전부 가능'(null)이면 null, 아니면 두 집합의 합", () => {
    const d1Pool = new Set(["갓"]);
    const all = new TieredDictionary(primaryOf({}, d1Pool), new Scripted("stdict", () => ({ valid: true }), null));
    expect(all.promptSyllables(2)).toBeNull();
    const seed = new TieredDictionary(primaryOf({}, d1Pool), new Scripted("local", () => ({ valid: true }), new Set(["가"])));
    expect(seed.promptSyllables(2)).toEqual(new Set(["갓", "가"]));
    const strict = new TieredDictionary(primaryOf({}, d1Pool), new Scripted("stdict", () => ({ valid: true }), null), { strict: true });
    expect(strict.promptSyllables(2)).toEqual(new Set(["갓"]));
  });
});
