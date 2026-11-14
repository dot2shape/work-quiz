/**
 * 방(Room)과 라운드 상태 머신.
 *
 * phase: lobby → countdown → playing → round_end → (playing ... | game_over) → lobby(restart)
 * 모든 시간 판단은 서버에서만 이루어진다. 실행 환경(Durable Object, 테스트)과는
 * broadcast/send/sleep/clock 콜백으로만 연결된다.
 */
import { Arbiter, type Submission } from "./arbiter";
import type { Dictionary } from "./dictionary";
import { isHangulWord, normalize } from "./hangul";
import { type Picker, PromptPicker } from "./prompts";
import type { Settings } from "./settings";

export type Phase = "lobby" | "countdown" | "playing" | "round_end" | "game_over";
export type Message = Record<string, unknown> & { type: string };
export type Broadcast = (msg: Message) => Promise<void>;
export type Send = (playerId: string, msg: Message) => Promise<void>;
/** 초 단위 대기. 취소되면 CancelledError 로 reject 되어야 한다. */
export type Sleep = (seconds: number, signal: AbortSignal) => Promise<void>;
export type Clock = () => number; // 초 단위 단조 시계

export const MAX_WORD_LEN = 20;
export const MAX_NICKNAME_LEN = 12;

// 단어 길이 모드: 0 = 자유(2글자 이상), 2 = 두글자만, 3 = 세글자만
export const WORD_LENGTH_MODES: Record<number, string> = { 0: "자유", 2: "두글자", 3: "세글자" };

/** 플레이어에게 그대로 보여 줄 수 있는 오류 메시지. */
export class RoomError extends Error {}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface Player {
  id: string;
  token: string;
  nickname: string;
  score: number;
  connected: boolean;
  cooldownUntil: number;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  score: number;
  connected: boolean;
}

function publicOf(p: Player): PublicPlayer {
  return { id: p.id, nickname: p.nickname, score: p.score, connected: p.connected };
}

/** 끝난 라운드 한 개의 기록. 정답 없이 시간 초과로 끝나면 word·winner_* 가 null 이다. */
export interface HistoryEntry {
  round: number;
  prompt: string;
  word: string | null;
  winner_id: string | null;
  /** 맞힌 시점의 닉네임. 플레이어가 나가도 결과표에 이름이 남도록 함께 저장한다. */
  winner_name: string | null;
}

export interface WordCount {
  word: string;
  count: number;
}

/** 히스토리의 정답 단어별 사용 횟수. 횟수 내림차순 → 가나다순. */
export function countWords(history: readonly HistoryEntry[]): WordCount[] {
  const counts = new Map<string, number>();
  for (const { word } of history) if (word !== null) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts]
    .map(([word, count]) => ({ word, count }))
    // 완성형 한글 음절은 코드 포인트 순서가 곧 가나다순이다
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

interface RoundResult {
  winnerId: string | null;
  winnerName: string | null;
  word: string | null;
  done: Promise<void>;
  finish: () => void;
  finished: boolean;
}

function newRoundResult(): RoundResult {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result: RoundResult = { winnerId: null, winnerName: null, word: null, done, finished: false, finish: () => {} };
  result.finish = () => {
    result.finished = true;
    finish();
  };
  return result;
}

export const defaultSleep: Sleep = (seconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, seconds * 1000));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const defaultClock: Clock = () => Date.now() / 1000;

function randomId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RoomDeps {
  picker?: Picker;
  sleep?: Sleep;
  clock?: Clock;
}

export class Room {
  readonly players = new Map<string, Player>();
  hostId: string | null = null;
  phase: Phase = "lobby";
  roundNo = 0;
  prompt: string | null = null;
  readonly usedWords = new Set<string>();
  readonly usedPrompts = new Set<string>();
  emptySince: number | null = null;
  roundEndsAt: number | null = null;
  wordLength = 0; // WORD_LENGTH_MODES 의 키
  allowDuplicates = false; // true 면 이미 나온 단어를 누구나 다시 내도 정답이다
  readonly history: HistoryEntry[] = []; // 이번 게임에서 끝난 라운드 기록

  private readonly picker: Picker;
  private readonly sleep: Sleep;
  private readonly clock: Clock;
  private arbiter: Arbiter | null = null;
  private round: RoundResult | null = null;
  private loop: AbortController | null = null;

  constructor(
    readonly code: string,
    private readonly dictionary: Dictionary,
    private readonly settings: Settings,
    private readonly broadcast: Broadcast,
    private readonly send: Send,
    deps: RoomDeps = {},
  ) {
    this.picker = deps.picker ?? new PromptPicker();
    this.sleep = deps.sleep ?? defaultSleep;
    this.clock = deps.clock ?? defaultClock;
  }

  // ── 플레이어 관리 ──────────────────────────────────────────────

  addPlayer(nickname: string, token: string | null = null): Player {
    if (token) {
      for (const p of this.players.values()) {
        if (p.token === token) {
          p.connected = true;
          this.emptySince = null;
          if (this.hostId === null || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
          return p;
        }
      }
    }
    const name = [...nickname.trim()].slice(0, MAX_NICKNAME_LEN).join("");
    if (!name) throw new RoomError("닉네임을 입력해 주세요");
    if (this.players.size >= this.settings.maxPlayers) {
      throw new RoomError(`방이 가득 찼습니다 (최대 ${this.settings.maxPlayers}명)`);
    }
    const player: Player = {
      id: randomId(4),
      token: randomId(16),
      nickname: name,
      score: 0,
      connected: true,
      cooldownUntil: 0,
    };
    this.players.set(player.id, player);
    this.emptySince = null;
    if (this.hostId === null) this.hostId = player.id;
    return player;
  }

  disconnect(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = false;
    if (this.phase === "lobby") this.players.delete(playerId);
    if (this.hostId === playerId) {
      this.hostId = [...this.players.values()].find((p) => p.connected)?.id ?? null;
    }
    if (this.isEmpty()) this.emptySince = this.clock();
  }

  isEmpty(): boolean {
    for (const p of this.players.values()) if (p.connected) return false;
    return true;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ── 상태 조회 ──────────────────────────────────────────────────

  state(): Message {
    return {
      type: "room_state",
      code: this.code,
      phase: this.phase,
      host_id: this.hostId,
      players: this.publicPlayers(),
      round: this.roundNo,
      prompt: this.phase === "playing" || this.phase === "round_end" ? this.prompt : null,
      used_words: [...this.usedWords].sort(),
      word_length: this.wordLength,
      mode_label: WORD_LENGTH_MODES[this.wordLength],
      allow_duplicates: this.allowDuplicates,
      target_score: this.settings.targetScore,
      round_seconds: this.settings.roundSeconds,
      dictionary_mode: this.dictionary.name,
      remaining_ms: this.remainingMs(),
      // 결과표는 게임이 끝난 뒤에만 공개한다. 새로고침·재접속해도 같은 표를 그릴 수 있게 state 에 담는다.
      ...(this.phase === "game_over" ? this.results() : { history: null, word_counts: null }),
    };
  }

  /** 게임 종료 결과표: 라운드 히스토리와 단어별 사용 횟수. */
  private results(): { history: HistoryEntry[]; word_counts: WordCount[] } {
    return { history: this.history.map((entry) => ({ ...entry })), word_counts: countWords(this.history) };
  }

  private publicPlayers(): PublicPlayer[] {
    return [...this.players.values()].map(publicOf);
  }

  private remainingMs(): number | null {
    if (this.phase !== "playing" || this.roundEndsAt === null) return null;
    return Math.max(0, Math.floor((this.roundEndsAt - this.clock()) * 1000));
  }

  // ── 게임 제어 ──────────────────────────────────────────────────

  async start(playerId: string): Promise<void> {
    if (playerId !== this.hostId) throw new RoomError("방장만 시작할 수 있습니다");
    if (this.phase !== "lobby") throw new RoomError("이미 게임이 진행 중입니다");
    if (this.connectedCount() < this.settings.minPlayers) {
      throw new RoomError(`${this.settings.minPlayers}명 이상 모여야 시작할 수 있습니다`);
    }
    this.phase = "countdown";
    this.loop = new AbortController();
    void this.gameLoop(this.loop.signal);
  }

  async setMode(playerId: string, wordLength: number): Promise<void> {
    if (playerId !== this.hostId) throw new RoomError("방장만 모드를 바꿀 수 있습니다");
    if (this.phase !== "lobby") throw new RoomError("모드는 로비에서만 바꿀 수 있습니다");
    if (!(wordLength in WORD_LENGTH_MODES)) throw new RoomError("지원하지 않는 모드입니다");
    this.wordLength = wordLength;
    await this.broadcast(this.state());
  }

  async setAllowDuplicates(playerId: string, allow: boolean): Promise<void> {
    if (playerId !== this.hostId) throw new RoomError("방장만 중복 허용 설정을 바꿀 수 있습니다");
    if (this.phase !== "lobby") throw new RoomError("중복 허용 설정은 로비에서만 바꿀 수 있습니다");
    this.allowDuplicates = allow;
    await this.broadcast(this.state());
  }

  /** 현재 모드에서 쓸 수 있는 제시어 집합. null이면 전체 목록. */
  private promptPool(): Set<string> | null {
    const pool = this.dictionary.promptSyllables(this.wordLength);
    return pool && pool.size ? pool : null;
  }

  async restart(playerId: string): Promise<void> {
    if (playerId !== this.hostId) throw new RoomError("방장만 다시 시작할 수 있습니다");
    if (this.phase !== "game_over") throw new RoomError("게임이 끝난 뒤에 다시 시작할 수 있습니다");
    this.reset();
    // 연결이 끊긴 플레이어는 로비에서 정리한다
    for (const p of [...this.players.values()]) if (!p.connected) this.players.delete(p.id);
    await this.broadcast(this.state());
  }

  private reset(): void {
    this.phase = "lobby";
    this.roundNo = 0;
    this.prompt = null;
    this.usedWords.clear();
    this.usedPrompts.clear();
    this.history.length = 0; // allowDuplicates 는 wordLength 처럼 다음 게임에도 유지한다
    this.roundEndsAt = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.cooldownUntil = 0;
    }
  }

  close(): void {
    this.arbiter?.close();
    this.loop?.abort();
    this.loop = null;
  }

  private async gameLoop(signal: AbortSignal): Promise<void> {
    try {
      while (true) {
        await this.runRound(signal);
        if (this.phase === "game_over") return;
        await this.sleep(this.settings.roundEndSeconds, signal);
        this.phase = "countdown";
      }
    } catch (err) {
      if (err instanceof CancelledError) return;
      console.error("게임 루프 오류", this.code, err);
      this.reset();
      await this.broadcast({ type: "error", message: "서버 오류로 게임이 중단되었습니다" });
      await this.broadcast(this.state());
    }
  }

  private async runRound(signal: AbortSignal): Promise<void> {
    // 카운트다운: 입력 잠금
    this.phase = "countdown";
    this.prompt = null;
    await this.broadcast(this.state());
    for (let value = this.settings.countdownSeconds; value > 0; value--) {
      await this.broadcast({ type: "countdown", value });
      await this.sleep(1, signal);
    }

    // 제시어 공개
    this.roundNo += 1;
    this.prompt = this.picker.next(this.usedPrompts, this.promptPool());
    this.usedPrompts.add(this.prompt);
    this.phase = "playing";
    this.roundEndsAt = this.clock() + this.settings.roundSeconds;
    const round = newRoundResult();
    this.round = round;
    const arbiter = new Arbiter(
      (sub) => this.onWinner(sub),
      (sub) => this.onRejected(sub),
    );
    this.arbiter = arbiter;
    await this.broadcast({
      type: "round_start",
      round: this.roundNo,
      prompt: this.prompt,
      round_seconds: this.settings.roundSeconds,
    });

    // 승자 확정 또는 제한 시간 경과까지 대기
    const timerAbort = new AbortController();
    const onOuterAbort = () => timerAbort.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      await Promise.race([this.sleep(this.settings.roundSeconds, timerAbort.signal), round.done]);
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
      timerAbort.abort();
    }
    if (signal.aborted) throw new CancelledError();
    arbiter.close();
    this.roundEndsAt = null;

    // 라운드 종료
    this.history.push({
      round: this.roundNo,
      prompt: this.prompt,
      word: round.word,
      winner_id: round.winnerId,
      winner_name: round.winnerName,
    });
    this.phase = "round_end";
    await this.broadcast({
      type: "round_end",
      round: this.roundNo,
      prompt: this.prompt,
      winner_id: round.winnerId,
      word: round.word,
      players: this.publicPlayers(),
    });

    const winner = round.winnerId ? this.players.get(round.winnerId) : undefined;
    if (winner && winner.score >= this.settings.targetScore) {
      this.phase = "game_over";
      await this.broadcast({
        type: "game_over",
        winner_id: winner.id,
        players: this.publicPlayers(),
        allow_duplicates: this.allowDuplicates,
        ...this.results(),
      });
    }
  }

  // ── 제출 처리 ──────────────────────────────────────────────────

  async submit(playerId: string, rawWord: string): Promise<void> {
    const player = this.players.get(playerId);
    if (!player) return;
    if (this.phase !== "playing" || !this.arbiter) {
      await this.reject(player, "지금은 제출할 수 없습니다", false);
      return;
    }
    const now = this.clock();
    if (now < player.cooldownUntil) {
      await this.reject(player, "잠시 후 다시 시도하세요", false, Math.floor((player.cooldownUntil - now) * 1000));
      return;
    }

    const word = normalize([...String(rawWord)].slice(0, MAX_WORD_LEN).join(""));
    if (!isHangulWord(word)) {
      await this.reject(player, "한글 2글자 이상의 단어만 인정됩니다");
      return;
    }
    if (this.wordLength && [...word].length !== this.wordLength) {
      await this.reject(player, `${WORD_LENGTH_MODES[this.wordLength]} 단어만 인정됩니다`);
      return;
    }
    if (!word.startsWith(this.prompt ?? "")) {
      await this.reject(player, `'${this.prompt}'(으)로 시작해야 합니다`);
      return;
    }
    if (!this.allowDuplicates && this.usedWords.has(word)) {
      await this.reject(player, "이미 나온 단어입니다");
      return;
    }

    this.arbiter.submit(player.id, word, this.dictionary.isNoun(word));
  }

  private async reject(player: Player, reason: string, cooldown = true, cooldownMs: number | null = null): Promise<void> {
    if (cooldown) {
      player.cooldownUntil = this.clock() + this.settings.cooldownSeconds;
      cooldownMs = Math.floor(this.settings.cooldownSeconds * 1000);
    }
    await this.send(player.id, {
      type: "submit_result",
      accepted: false,
      reason,
      cooldown_ms: cooldownMs ?? 0,
    });
  }

  private async onRejected(sub: Submission): Promise<void> {
    const player = this.players.get(sub.playerId);
    if (!player || !sub.verdict) return;
    // 사전 오류는 제출자 잘못이 아니므로 쿨다운을 주지 않는다
    await this.reject(player, sub.verdict.reason ?? "인정되지 않는 단어입니다", !sub.verdict.error);
  }

  private async onWinner(sub: Submission): Promise<void> {
    const round = this.round;
    if (!round || round.finished || this.phase !== "playing") return;
    const player = this.players.get(sub.playerId);
    if (!player) return;
    player.score += 1;
    this.usedWords.add(sub.word);
    round.winnerId = player.id;
    round.winnerName = player.nickname;
    round.word = sub.word;
    await this.send(player.id, { type: "submit_result", accepted: true, word: sub.word });
    round.finish();
  }
}
