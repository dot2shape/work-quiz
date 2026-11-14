/**
 * 적재 스크립트를 실제 프로세스로 실행해 종료 코드·stdout·stderr 를 확인한다 (#13).
 * node 내장 모듈을 쓰므로 .mjs 로 둔다: 이 프로젝트의 타입 검사는 Workers 타입만 쓰고 @types/node 가 없다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = (args) => spawnSync(process.execPath, ["scripts/dict/load.mjs", ...args], { encoding: "utf8" });

describe("적재 스크립트 — CLI --dry-run", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dict-load-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kind 가 다른 텍스트 파일 둘을 한 번에 읽고, 겹치면 경고를 stderr 에 낸다(종료 코드 0)", () => {
    writeFileSync(join(dir, "slang.txt"), "# kind: slang\n갓생\n바보\n");
    writeFileSync(join(dir, "banned.txt"), "# kind: banned\n바보\n멍청이\n");
    const result = run([join(dir, "slang.txt"), join(dir, "banned.txt"), "--replace", "--dry-run", "--out", join(dir, "out")]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("적재 대상(중복 제거 후): standard 0, slang 2, banned 2");
    expect(result.stderr).toMatch(/경고: slang 과 banned 에 모두 있는 단어 1개.*banned 우선.*바보/);
    expect(result.stdout.trim().split("\n")).toEqual([join(dir, "out", "0001-words.sql"), join(dir, "out", "9999-recalc.sql")]);
    const sql = readFileSync(join(dir, "out", "0001-words.sql"), "utf8");
    expect(sql).toContain("DELETE FROM words WHERE kind = 'slang' AND source = 'slang.txt';");
    expect(sql).toContain("DELETE FROM words WHERE kind = 'banned' AND source = 'banned.txt';");
    expect(sql).toContain("('바보', 'banned', 'banned.txt', NULL)");
  });

  it("저장소의 유행어·차단 목록은 경고 없이 읽힌다", () => {
    const result = run(["data/dict/slang.txt", "data/dict/banned.txt", "--replace", "--dry-run", "--out", join(dir, "out")]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("경고");
    expect(result.stderr).not.toContain("건너뜀 ");
    expect(result.stderr).toMatch(/적재 대상\(중복 제거 후\): standard 0, slang \d{3,}, banned \d{3,}/);
  });

  it("지시문과 --kind 가 다르면 종료 코드 2, 지시문도 --kind 도 없으면 종료 코드 2", () => {
    writeFileSync(join(dir, "banned.txt"), "# kind: banned\n바보\n");
    writeFileSync(join(dir, "words.txt"), "갓생\n");
    const mismatch = run([join(dir, "banned.txt"), "--kind", "slang", "--dry-run", "--out", join(dir, "out")]);
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain("kind 지시문(banned)과 --kind(slang)가 다릅니다");
    const missing = run([join(dir, "words.txt"), "--dry-run", "--out", join(dir, "out")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("--kind");
  });
});
