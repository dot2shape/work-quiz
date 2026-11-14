/**
 * 단어 판정 계층.
 *
 * - StdictClient      : 국립국어원 표준국어대사전 오픈 API 호출
 * - CachedDictionary  : 메모리 + KV 캐시 (오류 결과는 캐시하지 않음)
 * - LocalDictionary   : 로컬 시드 단어 목록 (API 키가 없을 때 개발용)
 * - FallbackDictionary: 주 사전 조회 실패 시 로컬 사전으로 판정 + 서킷 브레이커(방 간 공유)
 * - TieredDictionary  : 자체 DB(D1) → 없거나 조회 오류면 기존 경로
 * - BlocklistDictionary: 어떤 사전이든 판정 앞에서 차단 단어를 거절
 */
import { normalize } from "./hangul";

export const STDICT_URL = "https://stdict.korean.go.kr/api/search.do";

export const REASON_NOT_FOUND = "사전에 없는 단어입니다";
export const REASON_NOT_NOUN = "명사가 아닙니다";
export const REASON_LOOKUP_FAILED = "사전 조회에 실패했습니다. 다시 제출해 주세요";
export const REASON_BANNED = "사용할 수 없는 단어입니다";

export interface Verdict {
  valid: boolean;
  reason?: string | null;
  error?: boolean;
}

export interface Dictionary {
  readonly name: string;
  isNoun(word: string): Promise<Verdict>;
  /** 해당 길이의 단어가 충분한 첫 음절 집합. 알 수 없으면 null(전체 목록 사용). */
  promptSyllables(wordLength: number): Set<string> | null;
}

type Fetch = typeof fetch;

/** stdict 응답이 판정에 쓸 수 없는 형태일 때(진단용 분류). */
class StdictFailure extends Error {
  constructor(readonly kind: "http" | "empty" | "parse") {
    super(kind);
    this.name = "StdictFailure";
  }
}

/** 로그에 남길 응답 본문에서 API 키(`key=...` 꼴과 키 값 자체)를 가린다. */
export function maskKey(text: string, apiKey = ""): string {
  const masked = apiKey ? text.split(apiKey).join("***") : text;
  return masked.replace(/key=[^&\s"'<>]*/gi, "key=***");
}

interface StdictItem {
  word?: string;
  pos?: string;
}

/** 표준국어대사전 오픈 API로 '명사 표제어' 존재 여부를 확인한다. */
export class StdictClient implements Dictionary {
  readonly name = "stdict";

  constructor(
    private readonly apiKey: string,
    // 전역 fetch 를 필드에 담아 this.fetchImpl(...) 로 부르면 Workers 에서 Illegal invocation 이 난다(#19).
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 3000,
  ) {}

  async isNoun(word: string): Promise<Verdict> {
    const params = new URLSearchParams({
      key: this.apiKey,
      q: word,
      req_type: "json",
      advanced: "y",
      method: "exact",
      type1: "word", // 어휘만 (구·관용구·속담 제외)
      num: "50",
    });
    let data: { channel?: { item?: StdictItem | StdictItem[] } };
    const started = Date.now();
    let status = 0;
    let head = "";
    try {
      const resp = await this.fetchImpl(`${STDICT_URL}?${params}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = resp.status;
      const body = await resp.text();
      // 본문 전체에서 키를 가린 뒤 자른다(먼저 자르면 경계에 걸린 키 조각이 남는다).
      head = maskKey(body, this.apiKey).slice(0, 120);
      if (!resp.ok) throw new StdictFailure("http");
      // 키가 틀리거나 없으면 stdict는 HTTP 200 + 빈 본문을 돌려준다(2026-11-08 #9 확인).
      if (!body.trim()) throw new StdictFailure("empty");
      try {
        data = JSON.parse(body);
      } catch {
        throw new StdictFailure("parse");
      }
    } catch (err) {
      // 요청 URL은 key 가 들어 있어 남기지 않는다.
      const e = err as Error;
      const kind = err instanceof StdictFailure ? err.kind : e?.name === "TimeoutError" ? "timeout" : "network";
      console.warn(
        "stdict 조회 실패",
        JSON.stringify({ word, kind, status, ms: Date.now() - started, error: e?.name, head }),
      );
      return { valid: false, reason: REASON_LOOKUP_FAILED, error: true };
    }

    const rawItems = data?.channel?.item ?? [];
    const items: StdictItem[] = Array.isArray(rawItems) ? rawItems : [rawItems]; // 결과 1건이면 객체로 오는 경우 대비
    if (!items.length) return { valid: false, reason: REASON_NOT_FOUND };

    const matched = items.filter((it) => normalize(String(it.word ?? "")) === word);
    if (!matched.length) return { valid: false, reason: REASON_NOT_FOUND };
    const noun = matched.some((it) => {
      const pos = String(it.pos ?? "");
      return pos.includes("명사") && !pos.includes("대명사");
    });
    return noun ? { valid: true } : { valid: false, reason: REASON_NOT_NOUN };
  }

  promptSyllables(): Set<string> | null {
    return null; // 실제 사전은 모든 음절에 단어가 충분하다고 본다
  }
}

/** KV 바인딩 중 캐시에 필요한 부분만 추상화한다(테스트용 가짜 구현을 쉽게 만들기 위해). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** 내부 사전 결과를 메모리에 캐시하고 선택적으로 KV에 저장한다. */
export class CachedDictionary implements Dictionary {
  readonly name: string;
  private readonly memory = new Map<string, Verdict>();

  constructor(
    readonly inner: Dictionary,
    private readonly kv: KvLike | null,
    private readonly maxMemory = 10_000,
  ) {
    this.name = inner.name;
  }

  /** 캐시(메모리 → KV)에 있는 판정만 돌려준다. 내부 사전은 부르지 않는다. */
  async peek(word: string): Promise<Verdict | null> {
    const hit = this.memory.get(word);
    if (hit) {
      this.memory.delete(word);
      this.memory.set(word, hit); // LRU 갱신
      return hit;
    }
    if (this.kv) {
      try {
        const raw = await this.kv.get(`w:${word}`);
        if (raw) {
          const stored = JSON.parse(raw) as Verdict;
          this.remember(word, stored);
          return stored;
        }
      } catch (err) {
        console.warn("KV 캐시 조회 실패", word, String(err));
      }
    }
    return null;
  }

  async isNoun(word: string): Promise<Verdict> {
    const cached = await this.peek(word);
    if (cached) return cached;
    const verdict = await this.inner.isNoun(word);
    if (!verdict.error) {
      this.remember(word, verdict);
      if (this.kv) {
        try {
          await this.kv.put(`w:${word}`, JSON.stringify({ valid: verdict.valid, reason: verdict.reason ?? null }));
        } catch (err) {
          console.warn("KV 캐시 저장 실패", word, String(err));
        }
      }
    }
    return verdict;
  }

  private remember(word: string, verdict: Verdict): void {
    this.memory.set(word, verdict);
    while (this.memory.size > this.maxMemory) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  promptSyllables(wordLength: number): Set<string> | null {
    return this.inner.promptSyllables(wordLength);
  }

  get size(): number {
    return this.memory.size;
  }
}

/** 시드 단어 목록으로만 판정한다. API 키가 없는 개발 환경용. */
export class LocalDictionary implements Dictionary {
  readonly name = "local";

  constructor(private readonly words: Set<string>) {}

  static fromText(text: string): LocalDictionary {
    const words = new Set<string>();
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      for (const token of line.split(/\s+/)) words.add(normalize(token)); // 한 줄에 여러 단어 가능
    }
    return new LocalDictionary(words);
  }

  async isNoun(word: string): Promise<Verdict> {
    return this.words.has(word) ? { valid: true } : { valid: false, reason: REASON_NOT_FOUND };
  }

  /** 시드 목록에서 해당 길이 단어가 minWords개 이상인 첫 음절만 돌려준다. */
  promptSyllables(wordLength: number, minWords = 2): Set<string> | null {
    if (wordLength <= 0) return null;
    const counts = new Map<string, number>();
    for (const w of this.words) {
      if ([...w].length === wordLength) counts.set(w[0], (counts.get(w[0]) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n >= minWords).map(([s]) => s));
  }
}

export type DictionaryStatus = "stdict" | "stdict-degraded";

/** 연속 실패 시 cooldown 동안 주 경로를 건너뛰게 하는 서킷 브레이커. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    readonly threshold = 2,
    readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** 연속 실패가 임계값에 닿았다(쿨다운이 지나 다시 시도하는 반열림 포함). */
  get tripped(): boolean {
    return this.failures >= this.threshold;
  }

  /** 지금은 주 경로를 건너뛰어야 한다. */
  get open(): boolean {
    return this.tripped && this.now() < this.openUntil;
  }

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  /** 실패를 기록한다. 이 실패로 열렸으면(또는 다시 열렸으면) 열려 있을 시각, 아니면 null. */
  failure(): number | null {
    this.failures += 1;
    if (!this.tripped) return null;
    this.openUntil = this.now() + this.cooldownMs;
    return this.openUntil;
  }

  /** 다른 곳에서 알려 준 차단 상태를 반영한다. */
  tripUntil(until: number): void {
    this.failures = Math.max(this.failures, this.threshold);
    this.openUntil = Math.max(this.openUntil, until);
  }
}

export interface FallbackOptions {
  /** 이 횟수만큼 연속 실패하면 차단(open)한다. */
  failureThreshold?: number;
  /** 차단 후 주 사전을 다시 시도하기까지의 시간. */
  cooldownMs?: number;
  now?: () => number;
  /** 차단 상태를 방(DO) 간에 공유할 KV. 없으면 방별로만 동작한다. */
  shared?: KvLike | null;
  sharedKey?: string;
  /** 이미 떠 있는 방이 공유 플래그를 다시 확인하는 최소 간격. */
  sharedCheckMs?: number;
}

/** KV expirationTtl 의 최솟값(초). */
const KV_MIN_TTL_SECONDS = 60;

/**
 * 주 사전(stdict) 조회가 실패(`error: true`)하면 거절 대신 로컬 사전으로 판정한다.
 * 연속 실패 시 cooldown 동안 주 사전 호출을 건너뛰어 제출마다 타임아웃을 기다리지 않게 한다.
 * - 차단 상태는 KV 플래그(`shared`)로 방 간에 공유한다: 새 방이 같은 실패를 다시 겪지 않는다.
 * - 차단 중에도 주 사전의 캐시(KV)에 남은 판정은 먼저 쓰고, 없을 때만 로컬 사전으로 판정한다.
 * 폴백 판정은 주 사전 바깥에서 만들어지므로 CachedDictionary(KV)에 저장되지 않는다.
 */
export class FallbackDictionary implements Dictionary {
  readonly name: string;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  private readonly shared: KvLike | null;
  private readonly sharedKey: string;
  private readonly sharedCheckMs: number;
  private sharedCheckedAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly primary: Dictionary,
    readonly fallback: Dictionary,
    options: FallbackOptions = {},
  ) {
    this.name = primary.name;
    this.now = options.now ?? Date.now;
    this.breaker = new CircuitBreaker(options.failureThreshold ?? 2, options.cooldownMs ?? 60_000, this.now);
    this.shared = options.shared ?? null;
    this.sharedKey = options.sharedKey ?? "breaker:stdict";
    this.sharedCheckMs = options.sharedCheckMs ?? 30_000;
  }

  get status(): DictionaryStatus {
    return this.breaker.tripped ? "stdict-degraded" : "stdict";
  }

  /** 다른 방이 남긴 차단 플래그를 읽어 반영한다. DO 초기화 때 한 번, 이후에는 sharedCheckMs 간격으로만 읽는다. */
  async syncShared(): Promise<void> {
    if (!this.shared || this.breaker.open) return;
    const now = this.now();
    if (now - this.sharedCheckedAt < this.sharedCheckMs) return;
    this.sharedCheckedAt = now;
    try {
      const until = Number(await this.shared.get(this.sharedKey));
      if (Number.isFinite(until) && until > now) this.breaker.tripUntil(until);
    } catch (err) {
      console.warn("차단 플래그 조회 실패", String(err));
    }
  }

  async isNoun(word: string): Promise<Verdict> {
    await this.syncShared();
    if (this.breaker.open) return this.whileOpen(word);
    const verdict = await this.primary.isNoun(word);
    if (!verdict.error) {
      this.breaker.success();
      return verdict;
    }
    const wasTripped = this.breaker.tripped;
    const openUntil = this.breaker.failure();
    if (openUntil !== null) {
      if (!wasTripped) console.warn("stdict 차단: 로컬 사전으로 폴백", this.breaker.cooldownMs);
      await this.publish(openUntil);
    }
    return this.fallback.isNoun(word);
  }

  /** 차단 중: 주 사전의 캐시에 남은 판정이 있으면 그것을, 없으면 로컬 사전을 쓴다. */
  private async whileOpen(word: string): Promise<Verdict> {
    const peek = (this.primary as { peek?: (word: string) => Promise<Verdict | null> }).peek;
    const cached = peek ? await peek.call(this.primary, word) : null;
    return cached ?? this.fallback.isNoun(word);
  }

  private async publish(openUntil: number): Promise<void> {
    if (!this.shared) return;
    try {
      const ttl = Math.max(KV_MIN_TTL_SECONDS, Math.ceil(this.breaker.cooldownMs / 1000));
      await this.shared.put(this.sharedKey, String(openUntil), { expirationTtl: ttl });
    } catch (err) {
      console.warn("차단 플래그 저장 실패", String(err));
    }
  }

  promptSyllables(wordLength: number): Set<string> | null {
    return this.status === "stdict-degraded"
      ? this.fallback.promptSyllables(wordLength)
      : this.primary.promptSyllables(wordLength);
  }
}

export interface TieredOptions {
  /** true 면 주 사전에 없는 단어를 다음 사전에 묻지 않고 바로 거절한다(조회 오류는 여전히 넘긴다). */
  strict?: boolean;
  breaker?: CircuitBreaker;
}

/**
 * 자체 DB(주 사전) → 기존 경로(다음 사전) 순으로 판정한다.
 * - 주 사전이 인정하거나 차단하면 그 판정으로 끝낸다.
 * - 주 사전에 없으면 다음 사전에 묻는다(자체 DB 적재가 덜 된 동안의 기본 동작).
 * - 주 사전 조회 오류는 플레이어에게 보이지 않게 다음 사전으로 판정하고, 연속 오류면 잠시 건너뛴다.
 */
export class TieredDictionary implements Dictionary {
  readonly name: string;
  private readonly strict: boolean;
  private readonly breaker: CircuitBreaker;

  constructor(
    readonly primary: Dictionary,
    readonly secondary: Dictionary,
    options: TieredOptions = {},
  ) {
    this.name = primary.name;
    this.strict = options.strict ?? false;
    this.breaker = options.breaker ?? new CircuitBreaker();
  }

  async isNoun(word: string): Promise<Verdict> {
    if (!this.breaker.open) {
      const verdict = await this.primary.isNoun(word);
      if (!verdict.error) {
        this.breaker.success();
        if (verdict.valid || verdict.reason === REASON_BANNED || this.strict) return verdict;
      } else {
        const wasTripped = this.breaker.tripped;
        if (this.breaker.failure() !== null && !wasTripped) {
          console.warn(`${this.primary.name} 차단: ${this.secondary.name} 사전으로 폴백`, this.breaker.cooldownMs);
        }
      }
    }
    return this.secondary.isNoun(word);
  }

  promptSyllables(wordLength: number): Set<string> | null {
    const own = this.breaker.tripped ? null : this.primary.promptSyllables(wordLength);
    if (this.strict && own) return own;
    const rest = this.secondary.promptSyllables(wordLength);
    if (rest === null) return null; // 다음 사전이 모든 음절을 받는다
    return own ? new Set([...own, ...rest]) : rest;
  }
}

/** 어떤 사전이든 판정 앞에서 차단 단어를 거절한다. 거절은 오류가 아니므로 쿨다운 대상이다. */
export class BlocklistDictionary implements Dictionary {
  readonly name: string;

  constructor(
    readonly inner: Dictionary,
    private readonly banned: ReadonlySet<string>,
  ) {
    this.name = inner.name;
  }

  async isNoun(word: string): Promise<Verdict> {
    if (this.banned.has(word)) return { valid: false, reason: REASON_BANNED };
    return this.inner.isNoun(word);
  }

  promptSyllables(wordLength: number): Set<string> | null {
    return this.inner.promptSyllables(wordLength);
  }
}

/** /healthz 용: 알려진 단어로 stdict 를 탐침해 실제 상태를 보고한다(결과는 ttlMs 동안 캐시). */
export class StdictHealth {
  private cached: { at: number; status: DictionaryStatus } | null = null;

  constructor(
    private readonly client: Dictionary,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly probeWord = "사과",
  ) {}

  async status(): Promise<DictionaryStatus> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.status;
    const verdict = await this.client.isNoun(this.probeWord);
    const status: DictionaryStatus = verdict.error ? "stdict-degraded" : "stdict";
    this.cached = { at: this.now(), status };
    return status;
  }
}
