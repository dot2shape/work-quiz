import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REASON_BANNED, REASON_NOT_FOUND } from "../src/dictionary";
import { buildDictionary } from "../src/dictionary-build";
import type { Env } from "../src/env";
import { createDatabases, load, loadFixture, migrate, runSql } from "./helpers/d1";

const SEED = "# 시드\n가방 가위 강아지 강산 강물\n바보 바다\n";

let dbs: Record<"full" | "empty" | "bare" | "banOnly" | "broken", D1Database>;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ dbs, dispose } = await createDatabases(["full", "empty", "bare", "banOnly", "broken"] as const));
  await migrate(dbs.full);
  await loadFixture(dbs.full);
  await migrate(dbs.empty);
  await migrate(dbs.banOnly);
  await load(dbs.banOnly, "바보\n", { format: "text", kind: "banned" });
  await migrate(dbs.broken);
  await loadFixture(dbs.broken);
});

afterAll(async () => {
  await dispose();
});

class MemoryKv {
  readonly store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const envOf = (extra: Partial<Env>): Env => ({ DICT_CACHE: new MemoryKv() as unknown as KVNamespace, ...extra }) as Env;

/** stdict 대역: nouns 에 있으면 명사, 없으면 결과 없음. fail 이면 HTTP 500. */
function fakeStdict(nouns: string[], state = { fail: false, calls: 0 }) {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    state.calls += 1;
    if (state.fail) return new Response("boom", { status: 500 });
    const word = new URL(String(input)).searchParams.get("q") ?? "";
    return Response.json({ channel: { item: nouns.includes(word) ? [{ word, pos: "명사" }] : [] } });
  }) as typeof fetch;
  return { fetchImpl, state };
}

describe("buildDictionary — D1 없음·비어 있음·오류 → 기존 경로", () => {
  it("DICT_DB 바인딩이 없으면 시드 사전이다", async () => {
    const dict = await buildDictionary(envOf({}), SEED);
    expect(dict.name).toBe("local");
    expect(await dict.isNoun("강아지")).toEqual({ valid: true });
    expect((await dict.isNoun("갓생")).reason).toBe(REASON_NOT_FOUND);
  });

  it("빈 D1(스키마만)이면 시드로 판정한다", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.empty }), SEED);
    expect(dict.name).toBe("local");
    expect(await dict.isNoun("강아지")).toEqual({ valid: true });
    expect((await dict.isNoun("갓생")).reason).toBe(REASON_NOT_FOUND);
  });

  it("마이그레이션 전(테이블 없음)이어도 깨지지 않고 시드로 판정한다", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.bare }), SEED);
    expect(dict.name).toBe("local");
    expect(await dict.isNoun("가방")).toEqual({ valid: true });
  });

  it("초기화가 제한 시간 안에 끝나지 않으면 기다리지 않고 시드로 판정한다", async () => {
    const hanging = { prepare: () => ({ bind: () => ({}) }), batch: () => new Promise(() => {}) } as unknown as D1Database;
    const started = Date.now();
    const dict = await buildDictionary(envOf({ DICT_DB: hanging }), SEED, { initTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(dict.name).toBe("local");
  });

  it("차단 단어만 적재돼 있으면 시드 경로에 차단 층만 얹는다", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.banOnly }), SEED);
    expect(dict.name).toBe("local");
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED); // 시드에 있지만 차단
    expect(await dict.isNoun("바다")).toEqual({ valid: true });
  });
});

describe("buildDictionary — D1 적재됨", () => {
  it("D1 → (없으면) 시드 순으로 판정한다", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.full }), SEED);
    expect(dict.name).toBe("d1");
    expect(await dict.isNoun("사과")).toEqual({ valid: true }); // D1 standard
    expect(await dict.isNoun("갓생")).toEqual({ valid: true }); // D1 slang (시드에 없음)
    expect(await dict.isNoun("강아지")).toEqual({ valid: true }); // D1 에 없음 → 시드
    expect(await dict.isNoun("가뷁")).toEqual({ valid: false, reason: REASON_NOT_FOUND });
    const banned = await dict.isNoun("바보"); // D1 standard + 시드에도 있음
    expect(banned).toEqual({ valid: false, reason: REASON_BANNED });
  });

  it("제시어 집합은 D1 과 시드의 합이다(D1 일부만 적재된 동안 제시어가 좁아지지 않게)", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.full }), SEED);
    const pool = dict.promptSyllables(2)!;
    expect(pool.has("사")).toBe(true); // D1
    expect(pool.has("강")).toBe(true); // 시드(강산·강물)
    expect(dict.promptSyllables(0)).toBeNull(); // 시드는 자유 모드에서 모든 음절
  });

  it("게임 중 D1 조회가 실패해도 시드로 판정하고, 읽어 둔 차단 목록은 계속 적용된다", async () => {
    const dict = await buildDictionary(envOf({ DICT_DB: dbs.broken }), SEED);
    expect(await dict.isNoun("갓생")).toEqual({ valid: true });
    await runSql(dbs.broken, "DROP TABLE words;"); // 이후 조회는 D1_ERROR
    const viaSeed = await dict.isNoun("가위");
    expect(viaSeed).toEqual({ valid: true });
    const missing = await dict.isNoun("나심비"); // D1 에만 있던 유행어: 시드에 없으므로 거절(오류 아님)
    expect(missing).toEqual({ valid: false, reason: REASON_NOT_FOUND });
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED);
  });
});

describe("buildDictionary — stdict 경로", () => {
  it("키가 있고 D1 이 없으면 기존과 같이 stdict → 시드다", async () => {
    const { fetchImpl } = fakeStdict(["저고리"]);
    const dict = await buildDictionary(envOf({ STDICT_API_KEY: "k" }), SEED, { fetchImpl });
    expect(dict.name).toBe("stdict");
    expect(await dict.isNoun("저고리")).toEqual({ valid: true });
  });

  it("D1 에 없는 단어는 stdict 로, stdict 가 실패하면 시드로 판정한다", async () => {
    const { fetchImpl, state } = fakeStdict(["저고리"]);
    const dict = await buildDictionary(envOf({ STDICT_API_KEY: "k", DICT_DB: dbs.full }), SEED, { fetchImpl });
    expect(dict.name).toBe("d1");
    expect(await dict.isNoun("사과")).toEqual({ valid: true });
    expect(state.calls).toBe(0); // D1 에 있으면 stdict 를 부르지 않는다
    expect(await dict.isNoun("저고리")).toEqual({ valid: true }); // stdict
    expect(dict.promptSyllables(2)).toBeNull(); // stdict 정상: 모든 음절
    state.fail = true;
    expect(await dict.isNoun("강아지")).toEqual({ valid: true }); // 시드
    expect(await dict.isNoun("저승사자")).toEqual({ valid: false, reason: REASON_NOT_FOUND });
  });

  it("차단은 stdict 경로에도 적용된다: stdict 가 명사로 인정해도 거절한다", async () => {
    const { fetchImpl, state } = fakeStdict(["바보", "멍청이"]);
    const dict = await buildDictionary(envOf({ STDICT_API_KEY: "k", DICT_DB: dbs.banOnly }), SEED, { fetchImpl });
    expect(dict.name).toBe("stdict");
    expect((await dict.isNoun("바보")).reason).toBe(REASON_BANNED);
    expect(state.calls).toBe(0);
    expect(await dict.isNoun("멍청이")).toEqual({ valid: true }); // 이 DB 의 차단 목록에는 없다
  });

  it("오류 판정은 캐시하지 않는다: stdict 실패 때 시드로 낸 판정이 KV 에 남지 않는다", async () => {
    const kv = new MemoryKv();
    const { fetchImpl, state } = fakeStdict(["저고리"]);
    state.fail = true;
    const env = envOf({ STDICT_API_KEY: "k", DICT_DB: dbs.full, DICT_CACHE: kv as unknown as KVNamespace });
    const dict = await buildDictionary(env, SEED, { fetchImpl });
    await dict.isNoun("저고리");
    await dict.isNoun("사과");
    expect([...kv.store.keys()].filter((k) => k.startsWith("w:"))).toEqual([]);
  });

  it("다른 방이 남긴 stdict 차단 플래그를 초기화 때 읽는다", async () => {
    const kv = new MemoryKv();
    kv.store.set("breaker:stdict", String(Date.now() + 60_000));
    const { fetchImpl, state } = fakeStdict(["저고리"]);
    const env = envOf({ STDICT_API_KEY: "k", DICT_CACHE: kv as unknown as KVNamespace });
    const dict = await buildDictionary(env, SEED, { fetchImpl });
    expect((await dict.isNoun("저고리")).valid).toBe(false); // 시드에 없음 — stdict 를 부르지 않았다
    expect(state.calls).toBe(0);
  });
});
