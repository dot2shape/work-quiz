import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1Dictionary, D1Health, LOOKUP_SQL, loadD1Snapshot, readD1Stats } from "../src/d1-dictionary";
import { REASON_BANNED, REASON_NOT_FOUND } from "../src/dictionary";
import { createDatabases, load, loadFixture, migrate, runSql } from "./helpers/d1";

const SNAPSHOT_OPTS = { lengths: [0, 2, 3], syllables: ["가", "나", "사", "바", "하"] };

let dbs: Record<"full" | "empty" | "bare", D1Database>;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ dbs, dispose } = await createDatabases(["full", "empty", "bare"] as const));
  await migrate(dbs.full);
  await loadFixture(dbs.full);
  await migrate(dbs.empty); // 스키마만 있고 데이터 없음
  // bare: 마이그레이션도 적용되지 않은 DB (배포가 마이그레이션보다 먼저 된 경우)
});

afterAll(async () => {
  await dispose();
});

/** 조회가 실패하는 D1 대역. */
const brokenDb = (behaviour: "throw" | "hang") =>
  ({
    prepare: () => ({
      bind: () => ({
        all: () => (behaviour === "throw" ? Promise.reject(new Error("D1_ERROR: boom")) : new Promise(() => {})),
      }),
    }),
    batch: () => (behaviour === "throw" ? Promise.reject(new Error("D1_ERROR: boom")) : new Promise(() => {})),
  }) as unknown as D1Database;

describe("마이그레이션 + 적재 스크립트 SQL", () => {
  it("fixture 를 적재하면 kind 별 단어 수가 맞다", async () => {
    expect(await readD1Stats(dbs.full)).toEqual({ standard: 23, slang: 6, banned: 5 });
  });

  it("빈 DB 의 단어 수는 0 이다", async () => {
    expect(await readD1Stats(dbs.empty)).toEqual({ standard: 0, slang: 0, banned: 0 });
  });

  it("kind 제약: 정해진 세 값만 넣을 수 있다", async () => {
    await expect(dbs.empty.prepare("INSERT INTO words (word, kind) VALUES ('가방', 'noun')").run()).rejects.toThrow();
  });

  it("제시어 집계는 차단 단어를 빼고, 길이 0 에 전체 합계를 둔다", async () => {
    const rows = await dbs.full
      .prepare("SELECT word_length, n FROM prompt_syllables WHERE syllable = '사' ORDER BY word_length")
      .all<{ word_length: number; n: number }>();
    // 사: 2글자 사과·사람·사랑·사자, 3글자 사다리·사바사 (사기꾼은 차단)
    expect(rows.results).toEqual([
      { word_length: 0, n: 6 },
      { word_length: 2, n: 4 },
      { word_length: 3, n: 2 },
    ]);
  });

  it("--replace 로 차단 목록을 갈아 끼워도 사전 행은 남는다", async () => {
    const { dbs: tmp, dispose: done } = await createDatabases(["t"] as const);
    try {
      await migrate(tmp.t);
      await loadFixture(tmp.t);
      await load(tmp.t, "멍청이\n", { format: "text", kind: "banned", source: "fixture", replace: true });
      expect(await readD1Stats(tmp.t)).toEqual({ standard: 23, slang: 6, banned: 1 });
      const dict = new D1Dictionary(tmp.t);
      expect(await dict.isNoun("바보")).toEqual({ valid: true }); // 차단 해제 → 사전 행으로 인정
      expect((await dict.isNoun("멍청이")).reason).toBe(REASON_BANNED);
    } finally {
      await done();
    }
  });
});

describe("D1Dictionary", () => {
  it("standard·slang 이면 인정한다", async () => {
    const dict = new D1Dictionary(dbs.full);
    expect(dict.name).toBe("d1");
    expect(await dict.isNoun("가방")).toEqual({ valid: true }); // standard
    expect(await dict.isNoun("갓생")).toEqual({ valid: true }); // slang
  });

  it("차단 단어는 사전에 명사로 있어도 '사용할 수 없는 단어입니다'로 거절한다", async () => {
    const dict = new D1Dictionary(dbs.full);
    expect(await dict.isNoun("바보")).toEqual({ valid: false, reason: REASON_BANNED }); // standard + banned
    expect((await dict.isNoun("멍청이")).reason).toBe(REASON_BANNED); // banned 만
  });

  it("없는 단어는 '사전에 없는 단어입니다'(오류 아님)", async () => {
    const v = await new D1Dictionary(dbs.full).isNoun("가뷁");
    expect(v).toEqual({ valid: false, reason: REASON_NOT_FOUND });
  });

  it("판정 조회는 기본 키로 찾는다(전체 스캔 아님)", async () => {
    const plan = await dbs.full.prepare(`EXPLAIN QUERY PLAN ${LOOKUP_SQL}`).bind("가방").all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" | ");
    expect(detail).toContain("SEARCH");
    expect(detail).toContain("PRIMARY KEY");
    expect(detail).not.toContain("SCAN");
  });

  it("조회 오류·테이블 없음·시간 초과는 error 판정이다(예외를 던지지 않는다)", async () => {
    expect((await new D1Dictionary(dbs.bare).isNoun("가방")).error).toBe(true);
    expect((await new D1Dictionary(brokenDb("throw")).isNoun("가방")).error).toBe(true);
    expect((await new D1Dictionary(brokenDb("hang"), new Map(), 20).isNoun("가방")).error).toBe(true);
  });

  it("promptSyllables 는 미리 읽어 둔 메모리 값을 동기 반환한다", async () => {
    const snapshot = await loadD1Snapshot(dbs.full, SNAPSHOT_OPTS);
    const dict = new D1Dictionary(dbs.full, snapshot.prompts);
    expect(dict.promptSyllables(2)).toEqual(new Set(["가", "나", "사", "바"]));
    expect(dict.promptSyllables(3)).toEqual(new Set(["가", "나", "사", "바"]));
    expect(dict.promptSyllables(0)).toEqual(new Set(["가", "나", "사", "바"]));
    expect(dict.promptSyllables(7)).toBeNull(); // 읽어 두지 않은 길이
  });
});

describe("loadD1Snapshot (DO 초기화 때 한 번 읽는 값)", () => {
  it("단어 수·차단 목록·제시어 집합을 한 번에 읽는다", async () => {
    const snapshot = await loadD1Snapshot(dbs.full, SNAPSHOT_OPTS);
    expect(snapshot.stats).toEqual({ standard: 23, slang: 6, banned: 5 });
    expect(snapshot.banned).toEqual(new Set(["가식", "나부랭이", "사기꾼", "바보", "멍청이"]));
    expect([...snapshot.prompts.keys()].sort()).toEqual([0, 2, 3]);
  });

  it("요청한 음절만, minWords 이상인 것만 담는다", async () => {
    const snapshot = await loadD1Snapshot(dbs.full, { lengths: [2], syllables: ["가", "갓", "하"], minWords: 2 });
    expect(snapshot.prompts.get(2)).toEqual(new Set(["가"])); // 갓: 1단어, 하: 없음
    const loose = await loadD1Snapshot(dbs.full, { lengths: [2], syllables: ["가", "갓"], minWords: 1 });
    expect(loose.prompts.get(2)).toEqual(new Set(["가", "갓"]));
  });

  it("빈 DB 는 0 과 빈 집합을 돌려준다", async () => {
    const snapshot = await loadD1Snapshot(dbs.empty, SNAPSHOT_OPTS);
    expect(snapshot.stats).toEqual({ standard: 0, slang: 0, banned: 0 });
    expect(snapshot.banned.size).toBe(0);
    expect(snapshot.prompts.get(2)).toEqual(new Set());
  });

  it("테이블이 없으면 reject 한다(호출부가 기존 경로로 폴백)", async () => {
    await expect(loadD1Snapshot(dbs.bare, SNAPSHOT_OPTS)).rejects.toThrow();
  });

  it("한글 음절이 아닌 값은 SQL 에 넣지 않는다", async () => {
    await expect(loadD1Snapshot(dbs.full, { lengths: [2], syllables: ["가", "x'); DROP TABLE words;--"] })).rejects.toThrow(/음절/);
  });
});

describe("D1Health (/healthz)", () => {
  it("바인딩 없음·오류·비어 있음·사용 중을 구분하고 단어 수를 보인다", async () => {
    expect(await new D1Health(undefined).report()).toEqual({ status: "unbound" });
    expect(await new D1Health(dbs.bare).report()).toEqual({ status: "error" });
    expect(await new D1Health(dbs.empty).report()).toEqual({ status: "empty", standard: 0, slang: 0, banned: 0 });
    expect(await new D1Health(dbs.full).report()).toEqual({ status: "ready", standard: 23, slang: 6, banned: 5 });
  });

  it("결과를 TTL 동안 캐시한다", async () => {
    const { dbs: tmp, dispose: done } = await createDatabases(["t"] as const);
    try {
      let now = 0;
      await migrate(tmp.t);
      const health = new D1Health(tmp.t, 60_000, () => now);
      expect((await health.report()).status).toBe("empty");
      await loadFixture(tmp.t);
      expect((await health.report()).status).toBe("empty"); // 캐시
      now = 60_000;
      expect((await health.report()).status).toBe("ready");
    } finally {
      await done();
    }
  });

  it("차단 단어만 있으면 판정 사전으로는 비어 있다(empty)고 본다", async () => {
    const { dbs: tmp, dispose: done } = await createDatabases(["t"] as const);
    try {
      await migrate(tmp.t);
      await load(tmp.t, "바보\n", { format: "text", kind: "banned" });
      expect(await new D1Health(tmp.t).report()).toEqual({ status: "empty", standard: 0, slang: 0, banned: 1 });
      await runSql(tmp.t, "DELETE FROM dict_stats;"); // 집계가 아직 없어도 0 으로 읽는다
      expect((await new D1Health(tmp.t, 0).report()).status).toBe("empty");
    } finally {
      await done();
    }
  });
});
