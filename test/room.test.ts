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

  constructor(overrides: Partial<Settings> = {}, order: string[] = ["부", "신", "가"]) {
    const settings = { ...DEFAULT_SETTINGS, ...overrides };
    const dictionary = new LocalDictionary(new Set(["부산", "부모", "신발", "신문", "가방", "가족"]));
    this.room = new Room(
      "ABCDEF",
      dictionary,
      settings,
      async (m) => void this.broadcasts.push(m),
      async (pid, m) => void this.sent.push([pid, m]),
      { picker: new SequentialPicker(order), sleep: fastSleep },
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

/** 다음 라운드가 열리면 단어를 내고, 그 라운드가 끝날 때까지 기다린다. word 가 null 이면 시간 초과를 기다린다. */
async function playRound(h: Harness, playerId: string | null, word: string | null): Promise<void> {
  await waitPhase(h.room, "playing");
  const roundNo = h.room.roundNo;
  if (playerId && word) {
    const player = h.room.players.get(playerId)!;
    player.cooldownUntil = 0; // 앞 라운드 오답 쿨다운(실시간)을 테스트에서는 해제
    await h.room.submit(playerId, word);
  }
  const deadline = Date.now() + 2000;
  while (h.room.phase === "playing" && h.room.roundNo === roundNo) {
    if (Date.now() > deadline) throw new Error(`round ${roundNo} never ended`);
    await tick(2);
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

  // ── 중복 단어 허용 설정 + 라운드 히스토리 (#16) ───────────────────

  it("중복 허용 설정은 방장이 로비에서만 바꿀 수 있다", async () => {
    const h = new Harness();
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    expect(h.room.allowDuplicates).toBe(false);
    expect(h.room.state().allow_duplicates).toBe(false);

    await expect(h.room.setAllowDuplicates(b.id, true)).rejects.toThrow("방장만 중복 허용 설정을 바꿀 수 있습니다");
    expect(h.room.allowDuplicates).toBe(false);

    const before = h.ofType("room_state").length;
    await h.room.setAllowDuplicates(a.id, true);
    expect(h.room.allowDuplicates).toBe(true);
    expect(h.ofType("room_state").length).toBe(before + 1); // 바꾼 뒤 state 브로드캐스트
    expect(h.ofType("room_state").at(-1)!.allow_duplicates).toBe(true);

    await h.room.start(a.id);
    await expect(h.room.setAllowDuplicates(a.id, false)).rejects.toThrow("중복 허용 설정은 로비에서만 바꿀 수 있습니다");
    await waitPhase(h.room, "playing");
    await expect(h.room.setAllowDuplicates(a.id, false)).rejects.toThrow(RoomError);
    expect(h.room.allowDuplicates).toBe(true);
    expect(h.room.state().allow_duplicates).toBe(true); // 게임 중 state 에도 항상 담긴다
    h.room.close();
  });

  it("허용 모드에서는 본인·타인 모두 같은 단어로 다시 득점한다", async () => {
    const h = new Harness({ targetScore: 3 }, ["부", "부", "가", "부"]);
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await h.room.setAllowDuplicates(a.id, true);
    await h.room.start(a.id);

    await playRound(h, a.id, "부산");
    expect(a.score).toBe(1);
    await playRound(h, b.id, "부산"); // 남이 쓴 단어
    expect(b.score).toBe(1);
    expect(h.last(b.id)).toMatchObject({ accepted: true, word: "부산" });
    await playRound(h, a.id, "가방");
    expect(a.score).toBe(2);
    await playRound(h, a.id, "부산"); // 본인이 쓴 단어
    await waitPhase(h.room, "game_over");
    expect(a.score).toBe(3);

    const over = h.ofType("game_over").at(-1)!;
    expect(over.allow_duplicates).toBe(true);
    expect(over.history).toEqual([
      { round: 1, prompt: "부", word: "부산", winner_id: a.id, winner_name: "철수" },
      { round: 2, prompt: "부", word: "부산", winner_id: b.id, winner_name: "영희" },
      { round: 3, prompt: "가", word: "가방", winner_id: a.id, winner_name: "철수" },
      { round: 4, prompt: "부", word: "부산", winner_id: a.id, winner_name: "철수" },
    ]);
    // 횟수 내림차순 → 가나다순
    expect(over.word_counts).toEqual([
      { word: "부산", count: 3 },
      { word: "가방", count: 1 },
    ]);
    expect(h.room.state().used_words).toEqual(["가방", "부산"]); // used_words 는 중복 없이 유지
  });

  it("단어별 사용 횟수는 횟수 내림차순, 같으면 가나다순이다", async () => {
    const h = new Harness({ targetScore: 3 }, ["신", "부", "가", "부"]);
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await h.room.setAllowDuplicates(a.id, true);
    await h.room.start(a.id);
    await playRound(h, a.id, "신발");
    await playRound(h, b.id, "부모");
    await playRound(h, a.id, "가족");
    await playRound(h, a.id, "부모");
    await waitPhase(h.room, "game_over");
    expect(h.room.state().word_counts).toEqual([
      { word: "부모", count: 2 },
      { word: "가족", count: 1 },
      { word: "신발", count: 1 },
    ]);
  });

  it("비허용 모드(기본)에서는 이미 나온 단어를 거절한다", async () => {
    const h = new Harness({ targetScore: 2 }, ["부"]);
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    await h.room.start(a.id);
    await playRound(h, a.id, "부산");
    expect(a.score).toBe(1);

    await waitPhase(h.room, "playing");
    await h.room.submit(b.id, "부산"); // 남이 쓴 단어
    expect(h.last(b.id)).toMatchObject({ accepted: false, reason: "이미 나온 단어입니다" });
    await h.room.submit(a.id, "부산"); // 본인이 쓴 단어
    expect(h.last(a.id)).toMatchObject({ accepted: false, reason: "이미 나온 단어입니다" });
    expect(a.score).toBe(1);
    expect(b.score).toBe(0);
    expect(h.room.phase).toBe("playing");
    h.room.close();
  });

  it("시간 초과 라운드는 word: null 로 히스토리에 남는다", async () => {
    const h = new Harness({ targetScore: 1, roundSeconds: 1 }, ["부", "신"]);
    const a = h.room.addPlayer("철수");
    h.room.addPlayer("영희");
    await h.room.start(a.id);
    await playRound(h, null, null); // 1라운드: 아무도 못 맞힘
    expect(h.room.history).toEqual([{ round: 1, prompt: "부", word: null, winner_id: null, winner_name: null }]);
    await playRound(h, a.id, "신발");
    await waitPhase(h.room, "game_over");

    const expected = [
      { round: 1, prompt: "부", word: null, winner_id: null, winner_name: null },
      { round: 2, prompt: "신", word: "신발", winner_id: a.id, winner_name: "철수" },
    ];
    const over = h.ofType("game_over").at(-1)!;
    expect(over.history).toEqual(expected);
    expect(over.word_counts).toEqual([{ word: "신발", count: 1 }]); // 정답 없는 라운드는 세지 않는다
    expect(over.allow_duplicates).toBe(false);
  });

  it("game_over 단계의 state() 에 history·word_counts 가 담긴다 (재접속 대응)", async () => {
    const h = new Harness({ targetScore: 1 }, ["부"]);
    const a = h.room.addPlayer("철수");
    const b = h.room.addPlayer("영희");
    expect(h.room.state().history).toBeNull(); // 로비
    expect(h.room.state().word_counts).toBeNull();
    await h.room.start(a.id);
    await waitPhase(h.room, "playing");
    expect(h.room.state().history).toBeNull(); // 게임 중
    await playRound(h, b.id, "부모");
    await waitPhase(h.room, "game_over");

    // 맞힌 사람이 나갔다가 토큰으로 돌아와도(새로고침) 같은 결과가 state() 에 있다
    h.room.disconnect(b.id);
    const expected = [{ round: 1, prompt: "부", word: "부모", winner_id: b.id, winner_name: "영희" }];
    expect(h.room.state().history).toEqual(expected); // 나간 뒤에도 이름이 남는다
    h.room.addPlayer("영희", b.token);
    const state = h.room.state();
    expect(state.phase).toBe("game_over");
    expect(state.history).toEqual(expected);
    expect(state.word_counts).toEqual([{ word: "부모", count: 1 }]);
    expect(state.history).toEqual(h.ofType("game_over").at(-1)!.history);
  });

  it("다시 시작하면 히스토리는 비우고 중복 허용 설정은 유지한다", async () => {
    const h = new Harness({ targetScore: 1 }, ["부"]);
    const a = h.room.addPlayer("철수");
    h.room.addPlayer("영희");
    await h.room.setAllowDuplicates(a.id, true);
    await h.room.start(a.id);
    await playRound(h, a.id, "부산");
    await waitPhase(h.room, "game_over");
    expect(h.room.history.length).toBe(1);

    await h.room.restart(a.id);
    expect(h.room.history).toEqual([]);
    expect(h.room.allowDuplicates).toBe(true);
    const lobby = h.ofType("room_state").at(-1)!;
    expect(lobby.phase).toBe("lobby");
    expect(lobby.allow_duplicates).toBe(true);
    expect(lobby.history).toBeNull();

    // 다음 게임의 히스토리는 1라운드부터 새로 쌓인다
    await h.room.start(a.id);
    await playRound(h, a.id, "부산");
    await waitPhase(h.room, "game_over");
    expect(h.room.state().history).toEqual([
      { round: 1, prompt: "부", word: "부산", winner_id: a.id, winner_name: "철수" },
    ]);
  });
});
