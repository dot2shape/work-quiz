import { describe, expect, it } from "vitest";
import { Arbiter, type Submission } from "../src/arbiter";
import type { Verdict } from "../src/dictionary";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delayed = (verdict: Verdict, ms: number) => sleep(ms).then(() => verdict);

describe("Arbiter", () => {
  it("뒤 순번이 유효해도 앞 순번 결과를 기다린다", async () => {
    const winners: Submission[] = [];
    const arb = new Arbiter(async (s) => void winners.push(s));
    const first = arb.submit("p1", "부끄끄", delayed({ valid: false, reason: "x" }, 50));
    const second = arb.submit("p2", "부산", delayed({ valid: true }, 0));
    await sleep(10);
    expect(winners).toEqual([]); // 앞 순번이 아직 미해결이면 보류
    await sleep(100);
    expect(winners.map((w) => w.playerId)).toEqual(["p2"]);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it("앞 순번이 유효하면 느려도 앞 순번이 이긴다", async () => {
    const winners: Submission[] = [];
    const arb = new Arbiter(async (s) => void winners.push(s));
    arb.submit("p1", "부산", delayed({ valid: true }, 50));
    arb.submit("p2", "부모", delayed({ valid: true }, 0));
    await sleep(100);
    expect(winners.map((w) => w.playerId)).toEqual(["p1"]);
  });

  it("close 이후 도착한 결과는 무시한다", async () => {
    const winners: Submission[] = [];
    const arb = new Arbiter(async (s) => void winners.push(s));
    arb.submit("p1", "부산", delayed({ valid: true }, 50));
    arb.close();
    await sleep(100);
    expect(winners).toEqual([]);
  });

  it("오류 판정은 결과로 통보되지만 승자가 되지 않는다", async () => {
    const winners: Submission[] = [];
    const results: Submission[] = [];
    const arb = new Arbiter(async (s) => void winners.push(s), async (s) => void results.push(s));
    arb.submit("p1", "부산", delayed({ valid: false, error: true, reason: "판정 불가" }, 0));
    await sleep(20);
    expect(winners).toEqual([]);
    expect(results.map((r) => r.playerId)).toEqual(["p1"]);
  });

  it("검증 자체가 예외를 던지면 판정 불가로 다룬다", async () => {
    const results: Submission[] = [];
    const arb = new Arbiter(async () => {}, async (s) => void results.push(s));
    arb.submit("p1", "부산", Promise.reject(new Error("boom")));
    await sleep(20);
    expect(results[0]?.verdict?.error).toBe(true);
  });
});
