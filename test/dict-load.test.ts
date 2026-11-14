import { describe, expect, it } from "vitest";
import { buildSqlFiles, isHangulWord, normalizeWord, parseArgs, parseWords, recalcSql, UsageError } from "../scripts/dict/load.mjs";
import { isHangulWord as srcIsHangulWord, normalize as srcNormalize } from "../src/hangul";
import fixture from "./fixtures/dict-words.csv?raw";

describe("적재 스크립트 — 입력 파싱", () => {
  it("텍스트: 주석·빈 줄을 건너뛰고 공백으로 나눈 단어에 --kind 를 붙인다", () => {
    const { rows, skipped } = parseWords("# 주석\n갓생 가성비\n\n바프\n", { format: "text", kind: "slang", source: "slang.txt" });
    expect(rows).toEqual([
      { word: "갓생", kind: "slang", source: "slang.txt", pos: null },
      { word: "가성비", kind: "slang", source: "slang.txt", pos: null },
      { word: "바프", kind: "slang", source: "slang.txt", pos: null },
    ]);
    expect(skipped).toEqual([]);
  });

  it("CSV: 머리글 순서를 따르고, kind·source 가 비면 옵션 값을 쓴다", () => {
    const csv = "pos,word,kind\n명사,가방,standard\n,갓생,\n";
    const { rows } = parseWords(csv, { format: "csv", kind: "slang", source: "x" });
    expect(rows).toEqual([
      { word: "가방", kind: "standard", source: "x", pos: "명사" },
      { word: "갓생", kind: "slang", source: "x", pos: null },
    ]);
  });

  it("표제어 표기를 정규화하고, 한글 2글자 이상이 아니거나 kind 가 틀리면 건너뛴다", () => {
    const csv = "word,kind\n가-방,standard\n가로^등,standard\nA4,standard\n가,standard\n가위,noun\n";
    const { rows, skipped } = parseWords(csv, { format: "csv" });
    expect(rows.map((r) => r.word)).toEqual(["가방", "가로등"]);
    expect(skipped.map((s) => [s.line, s.value])).toEqual([[4, "A4"], [5, "가"], [6, "가위"]]);
  });

  it("word 열이 없는 CSV 는 오류다", () => {
    expect(() => parseWords("단어,종류\n가방,standard\n", { format: "csv" })).toThrow(/word/);
  });

  it("fixture 는 20~50 단어이고 세 종류가 섞여 있다", () => {
    const { rows, skipped } = parseWords(fixture, { format: "csv" });
    expect(skipped).toEqual([]);
    const words = new Set(rows.map((r) => r.word));
    expect(words.size).toBeGreaterThanOrEqual(20);
    expect(words.size).toBeLessThanOrEqual(50);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["standard", "slang", "banned"]));
  });

  it("한글 검증 규칙이 서버(src/hangul.ts)와 같다", () => {
    for (const sample of ["가방", " 가-방 ", "가로^등", "가", "A4", "가a", "ㄱㄴ", "", "갓생!", "가 방"]) {
      expect(normalizeWord(sample)).toBe(srcNormalize(sample));
      expect(isHangulWord(normalizeWord(sample))).toBe(srcIsHangulWord(srcNormalize(sample)));
    }
  });
});

describe("적재 스크립트 — SQL 생성", () => {
  const rows = [
    { word: "가방", kind: "standard", source: "s", pos: "명사" },
    { word: "가족", kind: "standard", source: "s", pos: "명사" },
    { word: "가방", kind: "standard", source: "s2", pos: null }, // 같은 (kind, word) → 뒤 행이 이긴다
    { word: "바보", kind: "banned", source: "it's", pos: null },
  ];

  it("행 수에 따라 파일을 나누고 마지막에 재계산 파일을 둔다", () => {
    const files = buildSqlFiles(rows, { rowsPerFile: 2 });
    expect(files.map((f) => f.name)).toEqual(["0001-words.sql", "0002-words.sql", "9999-recalc.sql"]);
    expect(files[0].sql).toContain("ON CONFLICT (kind, word) DO UPDATE");
    expect(files[0].sql.match(/'가방'/g)?.length).toBe(1);
    expect(files[0].sql).toContain("('가방', 'standard', 's2', NULL)");
    expect(files[2].sql).toBe(recalcSql());
  });

  it("작은따옴표를 이스케이프한다", () => {
    expect(buildSqlFiles(rows)[0].sql).toContain("'it''s'");
  });

  it("--replace 면 적재하는 (kind, source) 의 기존 행을 먼저 지운다", () => {
    const files = buildSqlFiles(rows, { replace: true });
    expect(files[0].name).toBe("0000-replace.sql");
    expect(files[0].sql).toContain("DELETE FROM words WHERE kind = 'standard' AND source = 's';");
    expect(files[0].sql).toContain("DELETE FROM words WHERE kind = 'banned' AND source = 'it''s';");
    expect(files[0].sql).not.toMatch(/DELETE FROM words;/);
  });

  it("단어가 없으면 재계산 파일만 만든다 (--recalc-only)", () => {
    expect(buildSqlFiles([], { replace: true }).map((f) => f.name)).toEqual(["9999-recalc.sql"]);
  });
});

describe("적재 스크립트 — 옵션", () => {
  it("--dry-run·--local·--remote 중 하나가 없으면 사용법 오류다", () => {
    expect(() => parseArgs(["words.txt", "--kind", "slang"])).toThrow(UsageError);
    expect(parseArgs(["words.txt", "--kind", "slang", "--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["words.csv", "--local"]).local).toBe(true);
  });

  it("잘못된 조합을 거절한다", () => {
    expect(() => parseArgs(["a.txt", "--local", "--remote"])).toThrow(UsageError);
    expect(() => parseArgs(["a.txt", "--kind", "noun", "--local"])).toThrow(UsageError);
    expect(() => parseArgs(["--local"])).toThrow(UsageError);
    expect(() => parseArgs(["a.txt", "--recalc-only", "--local"])).toThrow(UsageError);
    expect(() => parseArgs(["a.txt", "--local", "--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["a.txt", "--remote", "--persist-to", "x"])).toThrow(UsageError);
    expect(parseArgs(["--recalc-only", "--remote"]).recalcOnly).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
