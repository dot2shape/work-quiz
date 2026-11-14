/**
 * #24: 사전 조회를 못 했을 때(실패·차단 중) 시드에도 없는 단어를
 * "사전에 없는 단어"로 확정 거절하지 않고, 쿨다운 없이 재시도를 안내한다.
 */
import { describe, expect, it } from "vitest";
import {
  CachedDictionary,
  type Dictionary,
  FallbackDictionary,
  type KvLike,
  LocalDictionary,
  REASON_LOOKUP_DELAYED,
  REASON_NOT_FOUND,
  REASON_NOT_NOUN,
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
  ) {}
  async isNoun(word: string): Promise<Verdict> {
    this.calls.push(word);
    return this.answer(word);
  }
  promptSyllables(): Set<string> | null {
    return null;
  }
}

class MemoryKv implements KvLike {
  readonly store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const failing = () => new Scripted("stdict", () => ({ valid: false, error: true, reason: "판정 불가" }));
const seed = () => new LocalDictionary(new Set(["미술", "미래"]));
const DELAYED: Verdict = { valid: false, reason: REASON_LOOKUP_DELAYED, error: true };

describe("FallbackDictionary — 조회 실패 시 확정 거절하지 않는다 (#24)", () => {
  it("사유 문구는 '없는 단어'가 아니라 재시도 안내다", () => {
    expect(REASON_LOOKUP_DELAYED).toBe("사전 조회가 지연되고 있습니다. 다시 제출해 주세요");
    expect(REASON_LOOKUP_DELAYED).not.toBe(REASON_NOT_FOUND);
  });

  it("조회 실패 + 시드에 없음 → 재시도 안내(error 판정), 시드에 있으면 지금처럼 인정", async () => {
    const dict = new FallbackDictionary(failing(), seed(), { failureThreshold: 5 });
    expect(await dict.isNoun("미나리")).toEqual(DELAYED);
    expect(await dict.isNoun("미술")).toEqual({ valid: true });
  });

  it("차단(브레이커 열림) 중에도 캐시·시드에 없는 단어는 재시도 안내다", async () => {
    const kv = new MemoryKv();
    await kv.put("w:미역", JSON.stringify({ valid: true, reason: null }));
    await kv.put("w:미치다", JSON.stringify({ valid: false, reason: REASON_NOT_NOUN }));
    const inner = failing();
    const dict = new FallbackDictionary(new CachedDictionary(inner, kv), seed(), { failureThreshold: 1 });
    await dict.isNoun("미술"); // 실패 1회 → 열림
    expect(dict.status).toBe("stdict-degraded");
    const before = inner.calls.length;

    expect(await dict.isNoun("미나리")).toEqual(DELAYED);
    expect(await dict.isNoun("미래")).toEqual({ valid: true }); // 시드
    expect(await dict.isNoun("미역")).toMatchObject({ valid: true }); // 예전 stdict 판정(캐시)
    // 캐시에 남은 예전 stdict 거절은 실제 조회 결과이므로 확정 거절 그대로다
    expect(await dict.isNoun("미치다")).toEqual({ valid: false, reason: REASON_NOT_NOUN });
    expect(inner.calls.length).toBe(before); // 열린 동안 stdict 호출 없음
  });

  it("재시도 안내 판정은 KV 에 남지 않아, 조회가 회복되면 같은 단어가 인정된다", async () => {
    const kv = new MemoryKv();
    let down = true;
    const stdict = new Scripted("stdict", () => (down ? { valid: false, error: true } : { valid: true }));
    const dict = new FallbackDictionary(new CachedDictionary(stdict, kv), seed(), { failureThreshold: 5 });
    expect(await dict.isNoun("미나리")).toEqual(DELAYED);
    expect(kv.store.size).toBe(0);
    down = false;
    expect(await dict.isNoun("미나리")).toEqual({ valid: true });
  });

  it("D1 → 기존 경로(TieredDictionary)로 조립돼도 재시도 안내가 그대로 전달된다", async () => {
    const d1 = new Scripted("d1", () => ({ valid: false, reason: REASON_NOT_FOUND }));
    const dict = new TieredDictionary(d1, new FallbackDictionary(failing(), seed(), { failureThreshold: 5 }));
    expect(await dict.isNoun("미나리")).toEqual(DELAYED);
    expect(await dict.isNoun("미술")).toEqual({ valid: true });
  });
});

describe("Room — 조회 실패 거절에는 쿨다운이 없다 (#24)", () => {
  const fastSleep: Sleep = (seconds, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), seconds * 10);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(new CancelledError())), { once: true });
    });
  const picker: Picker = { next: () => "미" };
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  it("재시도 안내를 받은 직후 다시 제출할 수 있고, 조회가 회복되면 득점한다", async () => {
    let down = true;
    const stdict = new Scripted("stdict", (word) =>
      down ? { valid: false, error: true } : word === "미나리" ? { valid: true } : { valid: false, reason: REASON_NOT_FOUND },
    );
    const dict = new FallbackDictionary(stdict, seed(), { failureThreshold: 5 });
    const sent: Array<[string, Message]> = [];
    const room = new Room("ABCDEF", dict, DEFAULT_SETTINGS, async () => {}, async (pid, m) => void sent.push([pid, m]), {
      picker,
      sleep: fastSleep,
    });
    const a = room.addPlayer("철수");
    room.addPlayer("영희");
    await room.start(a.id);
    while (room.phase !== "playing") await tick(2);
    const results = () => sent.filter(([pid, m]) => pid === a.id && m.type === "submit_result").map(([, m]) => m);

    await room.submit(a.id, "미나리"); // stdict 실패 + 시드에 없음
    await tick();
    expect(results().at(-1)).toMatchObject({ accepted: false, reason: REASON_LOOKUP_DELAYED, cooldown_ms: 0 });
    expect(a.cooldownUntil).toBe(0);

    down = false;
    await room.submit(a.id, "미나리"); // 쿨다운 없이 바로 재제출
    await tick();
    expect(results().at(-1)).toMatchObject({ accepted: true, word: "미나리" });
    expect(a.score).toBe(1);
    room.close();
  });

  it("실제 조회 결과가 '없는 단어'면 지금처럼 쿨다운과 함께 거절한다", async () => {
    const stdict = new Scripted("stdict", () => ({ valid: false, reason: REASON_NOT_FOUND }));
    const dict = new FallbackDictionary(stdict, seed());
    const sent: Array<[string, Message]> = [];
    const room = new Room("ABCDEF", dict, DEFAULT_SETTINGS, async () => {}, async (pid, m) => void sent.push([pid, m]), {
      picker,
      sleep: fastSleep,
    });
    const a = room.addPlayer("철수");
    room.addPlayer("영희");
    await room.start(a.id);
    while (room.phase !== "playing") await tick(2);
    await room.submit(a.id, "미뷁뷁");
    await tick();
    const result = sent.filter(([pid, m]) => pid === a.id && m.type === "submit_result").at(-1)![1];
    expect(result).toMatchObject({ accepted: false, reason: REASON_NOT_FOUND });
    expect(Number(result.cooldown_ms)).toBeGreaterThan(0);
    room.close();
  });
});
