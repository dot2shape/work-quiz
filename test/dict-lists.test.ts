/** 저장소의 유행어·차단 목록 원본(data/dict/*.txt)이 기준(#13, data/dict/README.md)을 지키는지 확인한다. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findDuplicates, findKindConflicts, parseWords } from "../scripts/dict/load.mjs";
import { D1Dictionary, loadD1Snapshot, readD1Stats } from "../src/d1-dictionary";
import { REASON_BANNED } from "../src/dictionary";
import bannedText from "../data/dict/banned.txt?raw";
import slangText from "../data/dict/slang.txt?raw";
import seedText from "../data/seed_words.txt?raw";
import { createDatabases, load, migrate } from "./helpers/d1";

const slang = parseWords(slangText, { format: "text", source: "slang.txt" });
const banned = parseWords(bannedText, { format: "text", source: "banned.txt" });
const seed = parseWords(seedText, { format: "text", kind: "standard" });

describe("data/dict 목록 원본", () => {
  it("slang.txt: kind 지시문이 slang 이고, 한글 2글자 이상 단어가 200개 이상이며 건너뛴 줄·중복이 없다", () => {
    expect(new Set(slang.rows.map((r) => r.kind))).toEqual(new Set(["slang"]));
    expect(slang.skipped).toEqual([]);
    expect(findDuplicates(slang.rows)).toEqual([]);
    expect(slang.rows.length).toBeGreaterThanOrEqual(200);
  });

  it("banned.txt: kind 지시문이 banned 이고, 100개 이상이며 건너뛴 줄·중복이 없다", () => {
    expect(new Set(banned.rows.map((r) => r.kind))).toEqual(new Set(["banned"]));
    expect(banned.skipped).toEqual([]);
    expect(findDuplicates(banned.rows)).toEqual([]);
    expect(banned.rows.length).toBeGreaterThanOrEqual(100);
  });

  it("한 줄에 한 단어다", () => {
    for (const text of [slangText, bannedText]) {
      const multi = text.split(/\r?\n/).filter((line: string) => line.trim() && !line.trim().startsWith("#") && /\s/.test(line.trim()));
      expect(multi).toEqual([]);
    }
  });

  it("두 목록에 동시에 있는 단어가 없다", () => {
    expect(findKindConflicts([...slang.rows, ...banned.rows])).toEqual([]);
  });

  it("일상어와 동형인 단어는 차단하지 않는다 (README 의 예시·시드 단어)", () => {
    const blocked = new Set(banned.rows.map((r) => r.word));
    for (const word of ["새끼", "걸레", "고자", "등신", "대가리", "검둥이", "홍어", "쓰레기", "시발점", "시발역"]) expect(blocked.has(word), word).toBe(false);
    expect(seed.rows.map((r) => r.word).filter((w) => blocked.has(w))).toEqual([]);
  });

  it("banned.txt 머리 주석에 출처·라이선스를 적었다", () => {
    const head = bannedText.split(/\r?\n/).slice(0, 15).join("\n");
    expect(head).toMatch(/출처/);
    expect(head).toMatch(/라이선스/);
  });
});

describe("data/dict 목록을 D1 에 적재하면", () => {
  let dbs: Record<"lists" | "overlap", D1Database>;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ dbs, dispose } = await createDatabases(["lists", "overlap"] as const));
    await migrate(dbs.lists);
    await load(dbs.lists, slangText, { format: "text", source: "slang.txt", replace: true });
    await load(dbs.lists, bannedText, { format: "text", source: "banned.txt", replace: true });
    await migrate(dbs.overlap);
    await load(dbs.overlap, "# kind: slang\n갓생\n갑질\n", { format: "text", source: "slang.txt" });
    await load(dbs.overlap, "# kind: banned\n갑질\n", { format: "text", source: "banned.txt" });
  });

  afterAll(async () => {
    await dispose();
  });

  it("유행어는 인정하고 비속어는 '사용할 수 없는 단어입니다'로 거절한다", async () => {
    expect(await readD1Stats(dbs.lists)).toEqual({ standard: 0, slang: slang.rows.length, banned: banned.rows.length });
    const dict = new D1Dictionary(dbs.lists);
    for (const word of ["갓생", "가성비", "워라밸"]) expect(await dict.isNoun(word), word).toEqual({ valid: true });
    for (const word of ["병신", "씨발"]) expect(await dict.isNoun(word), word).toEqual({ valid: false, reason: REASON_BANNED });
    const snapshot = await loadD1Snapshot(dbs.lists, { lengths: [0], syllables: ["갓", "병"] });
    expect(snapshot.banned.size).toBe(banned.rows.length);
  });

  it("같은 단어가 slang 과 banned 에 모두 있으면 banned 가 우선한다 (판정·제시어 집계)", async () => {
    const dict = new D1Dictionary(dbs.overlap);
    expect(await dict.isNoun("갑질")).toEqual({ valid: false, reason: REASON_BANNED });
    expect(await dict.isNoun("갓생")).toEqual({ valid: true });
    const snapshot = await loadD1Snapshot(dbs.overlap, { lengths: [2], syllables: ["갓", "갑"], minWords: 1 });
    expect(snapshot.banned).toEqual(new Set(["갑질"]));
    expect(snapshot.prompts.get(2)).toEqual(new Set(["갓"])); // 차단된 '갑질'은 제시어 집계에서 빠진다
  });
});
