import { describe, expect, it } from "vitest";
import { LocalDictionary } from "../src/dictionary";
import type { Picker } from "../src/prompts";
import { CancelledError, type Message, Room, RoomError, type Sleep } from "../src/room";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings";

const SCALE = 0.01; // 테스트에서는 모든 대기 시간을 1/100로 줄인다

const fastSleep: Sleep = (seconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const t = setTimeout(() => resolve(), seconds * SCALE * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new CancelledError());
    }, { once: true });
  });

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 테스트용: 제시어를 '부' → '신' → '가' 순서로 고정한다. */
class SequentialPicker implements Picker {
  private i = 0;
  constructor(private readonly order: string[]) {}
  next(): string {
    return this.order[this.i++ % this.order.length];
  }
}

class Harness {
  broadcasts: Message[] = [];
  sent: Array<[string, Message]> = [];
  room: Room;

  constructor(overrides: Partial<Settings> = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    const dictionary = new LocalDictionary(new Set(["부산", "부모", "신발", "신문", "가방", "가족"]));
    this.room = new Room(
      "ABCDEF",
      dictionary,
      settings,
      async (m) => void this.broadcasts.push(m),
      async (pid, m) => void this.sent.push([pid, m]),
      { picker: new SequentialPicker(["부", "신", "가"]), sleep: fastSleep },
    );
  }

  resultsFor(playerId: string): Message[] {
    return this.sent.filter(([pid, m]) => pid === playerId && m.type === "submit_result").map(([, m]) => m);
  }
  last(playerId: string): Message {
    const list = this.resultsFor(playerId);
    return list[list.length - 1];
  }
  ofType(t: string): Message[] {
    return this.broadcasts.filter((m) => m.type === t);
  }
}

async function waitPhase(room: Room, phase: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (room.phase !== phase) {
    if (Date.now() > deadline) throw new Error(`phase ${room.phase} never became ${phase}`);
    await tick(2);
  }
}

describe("Room", () => {
  it("승리까지 전체 흐름", async () => {
    const h = new Harness({ targetScore: 2 });
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    expect(h.room.hostId).toBe(a.id);
    expect(h.room.phase).toBe("lobby");

    await h.room.start(a.id);
    expect(h.room.phase).toBe("countdown");
    // 카운트다운 중 제출은 거부되고 점수에 반영되지 않는다
    await h.room.submit(a.id, "부산");
    expect(h.last(a.id).accepted).toBe(false);
    expect(a.score).toBe(0);

    await waitPhase(h.room, "playing");
    expect(h.room.prompt).toBe("부");
    await h.room.submit(b.id, "부끄끄"); // 사전에 없음
    await tick();
    expect(h.last(b.id).accepted).toBe(false);
    expect(String(h.last(b.id).reason)).toContain("사전");
    expect(Number(h.last(b.id).cooldown_ms)).toBeGreaterThan(0);

    await h.room.submit(a.id, "부산");
    await waitPhase(h.room, "round_end");
    expect(a.score).toBe(1);
    expect(h.room.usedWords.has("부산")).toBe(true);
    const re = h.ofType("round_end").at(-1)!;
    expect(re.winner_id).toBe(a.id);
    expect(re.word).toBe("부산");

    await waitPhase(h.room, "playing");
    expect(["신", "가"]).toContain(h.room.prompt);
    b.cooldownUntil = 0; // 앞 라운드 오답 쿨다운(실시간 1초)을 테스트에서는 해제
    await h.room.submit(b.id, h.room.prompt === "신" ? "신발" : "가방");
    await waitPhase(h.room, "round_end");
    expect(b.score).toBe(1);

    await waitPhase(h.room, "playing");
    const word = { 신: "신문", 가: "가족", 부: "부모" }[h.room.prompt!]!;
    await h.room.submit(a.id, word);
    await waitPhase(h.room, "game_over");
    expect(a.score).toBe(2);
    expect(h.ofType("game_over").at(-1)!.winner_id).toBe(a.id);

    // 다시 시작 → 로비, 점수 초기화
    await h.room.restart(a.id);
    expect(h.room.phase).toBe("lobby");
    expect(a.score).toBe(0);
    expect(h.room.usedWords.size).toBe(0);
  });

  it("사용한 단어·접두 불일치·쿨다운을 거절한다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    h.room.usedWords.add("부산");
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    await h.room.submit(a.id, "부산");
    await tick();
    expect(h.last(a.id).reason).toBe("이미 나온 단어입니다");
    await h.room.submit(b.id, "신발");
    expect(String(h.last(b.id).reason)).toContain("부");
    await h.room.submit(b.id, "부");
    expect(h.last(b.id).accepted).toBe(false); // 쿨다운 안내
    h.room.close();
  });

  it("승자 확정 뒤의 유효 제출은 득점하지 않는다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    await h.room.submit(a.id, "부산");
    await h.room.submit(b.id, "부모");
    await waitPhase(h.room, "round_end");
    await tick(20);
    expect(a.score).toBe(1);
    expect(b.score).toBe(0);
    h.room.close();
  });

  it("제한 시간이 지나면 승자 없이 라운드가 끝난다", async () => {
    const h = new Harness({ roundSeconds: 1 });
    const a = h.room.addPlayer("철수");
    h.room.addPlayer("영희");
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    await waitPhase(h.room, "round_end");
    expect(h.ofType("round_end").at(-1)!.winner_id).toBeNull();
    h.room.close();
  });

  it("방장 승계와 토큰 재접속", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    h.room.disconnect(a.id);
    expect(h.room.hostId).toBe(b.id);
    expect(a.connected).toBe(false);
    expect(h.room.players.has(a.id)).toBe(true); // 게임 중에는 자리를 유지
    const again = h.room.addPlayer("철수", a.token);
    expect(again).toBe(a);
    expect(a.connected).toBe(true);
    h.room.disconnect(a.id);
    h.room.disconnect(b.id);
    expect(h.room.isEmpty()).toBe(true);
    h.room.close();
  });

  it("로비 퇴장은 플레이어를 제거한다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    h.room.disconnect(b.id);
    expect(h.room.players.has(b.id)).toBe(false);
    await expect(h.room.start(a.id)).rejects.toThrow(RoomError); // 2명 미만
    const c = h.room.addPlayer("민수");
    await expect(h.room.start(c.id)).rejects.toThrow(RoomError); // 방장이 아님
  });

  it("정원 초과와 빈 닉네임을 거절한다", () => {
    const h = new Harness();
    for (let i = 0; i < 8; i++) h.room.addPlayer(`p${i}`);
    expect(() => h.room.addPlayer("p9")).toThrow(RoomError);
    expect(() => new Harness().room.addPlayer("   ")).toThrow(RoomError);
  });

  it("단어 길이 모드는 다른 길이를 거절한다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await expect(h.room.setMode(b.id, 2)).rejects.toThrow(RoomError); // 방장이 아님
    await expect(h.room.setMode(a.id, 4)).rejects.toThrow(RoomError); // 지원하지 않는 길이
    await h.room.setMode(a.id, 3);
    expect(h.room.state().word_length).toBe(3);
    expect(h.room.state().mode_label).toBe("세글자");
    await h.room.start(a.id);
    await expect(h.room.setMode(a.id, 2)).rejects.toThrow(RoomError); // 로비가 아님
    await waitPhase(h.room, "playing");
    await h.room.submit(b.id, "부산");
    expect(h.last(b.id).reason).toBe("세글자 단어만 인정됩니다");
    h.room.close();
  });

  it("다시 시작해도 모드는 유지된다", async () => {
    const h = new Harness({ targetScore: 1 });
    const a = h.room.addPlayer("철수");
    h.room.addPlayer("영희");
    await h.room.setMode(a.id, 2);
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    await h.room.submit(a.id, "부산");
    await waitPhase(h.room, "game_over");
    await h.room.restart(a.id);
    expect(h.room.wordLength).toBe(2);
  });

  it("close 는 진행 중인 게임 루프를 멈춘다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    h.room.addPlayer("영희");
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    const before = h.broadcasts.length;
    h.room.close();
    await tick(100);
    expect(h.broadcasts.length).toBe(before); // 더 이상 브로드캐스트가 없다
    expect(h.ofType("error")).toEqual([]);
  });
});
