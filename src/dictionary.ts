/**
 * 단어 판정 계층.
 *
 * - StdictClient      : 국립국어원 표준국어대사전 오픈 API 호출
 * - CachedDictionary  : 메모리 + KV 캐시 (오류 결과는 캐시하지 않음)
 * - LocalDictionary   : 로컬 시드 단어 목록 (API 키가 없을 때 개발용)
 * - FallbackDictionary: 주 사전 조회 실패 시 로컬 사전으로 판정 + 서킷 브레이커
 */
import { normalize } from "./hangul";

export const STDICT_URL = "https://stdict.korean.go.kr/api/search.do";

export const REASON_NOT_FOUND = "사전에 없는 단어입니다";
export const REASON_NOT_NOUN = "명사가 아닙니다";
export const REASON_LOOKUP_FAILED = "사전 조회에 실패했습니다. 다시 제출해 주세요";

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

interface StdictItem {
  word?: string;
  pos?: string;
}

/** 표준국어대사전 오픈 API로 '명사 표제어' 존재 여부를 확인한다. */
export class StdictClient implements Dictionary {
  readonly name = "stdict";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
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
      head = body.slice(0, 120);
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
  put(key: string, value: string): Promise<void>;
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

  async isNoun(word: string): Promise<Verdict> {
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

export interface FallbackOptions {
  /** 이 횟수만큼 연속 실패하면 차단(open)한다. */
  failureThreshold?: number;
  /** 차단 후 주 사전을 다시 시도하기까지의 시간. */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * 주 사전(stdict) 조회가 실패(`error: true`)하면 거절 대신 로컬 사전으로 판정한다.
 * 연속 실패 시 cooldown 동안 주 사전 호출을 건너뛰어 제출마다 타임아웃을 기다리지 않게 한다.
 * 폴백 판정은 주 사전 바깥에서 만들어지므로 CachedDictionary(KV)에 저장되지 않는다.
 */
export class FallbackDictionary implements Dictionary {
  readonly name: string;
  private failures = 0;
  private openUntil = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly primary: Dictionary,
    readonly fallback: Dictionary,
    options: FallbackOptions = {},
  ) {
    this.name = primary.name;
    this.failureThreshold = options.failureThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get status(): DictionaryStatus {
    return this.failures >= this.failureThreshold ? "stdict-degraded" : "stdict";
  }

  async isNoun(word: string): Promise<Verdict> {
    if (this.failures >= this.failureThreshold && this.now() < this.openUntil) {
      return this.fallback.isNoun(word);
    }
    const verdict = await this.primary.isNoun(word);
    if (!verdict.error) {
      this.failures = 0;
      this.openUntil = 0;
      return verdict;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      if (this.failures === this.failureThreshold) console.warn("stdict 차단: 로컬 사전으로 폴백", this.cooldownMs);
      this.openUntil = this.now() + this.cooldownMs;
    }
    return this.fallback.isNoun(word);
  }

  promptSyllables(wordLength: number): Set<string> | null {
    return this.status === "stdict-degraded"
      ? this.fallback.promptSyllables(wordLength)
      : this.primary.promptSyllables(wordLength);
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
