/**
 * 자체 단어 DB(Cloudflare D1) 판정.
 *
 * - D1Dictionary   : words 테이블로 판정 (standard·slang 인정, banned 거절)
 * - loadD1Snapshot : DO 초기화 때 한 번 읽어 메모리에 두는 값(단어 수·차단 목록·제시어 집합)
 * - D1Health       : /healthz 용 단어 수 보고
 *
 * 스키마는 migrations/0001_words.sql, 적재는 scripts/dict/load.mjs.
 */
import { type Dictionary, REASON_BANNED, REASON_LOOKUP_FAILED, REASON_NOT_FOUND, type Verdict } from "./dictionary";
import { isHangulSyllable } from "./hangul";

export type WordKind = "standard" | "slang" | "banned";

export interface D1Stats {
  standard: number;
  slang: number;
  banned: number;
}

export interface D1Snapshot {
  stats: D1Stats;
  /** 차단 단어 전체. 판정 앞단(BlocklistDictionary)에서 쓴다. */
  banned: Set<string>;
  /** 단어 길이(0 = 자유) → 인정 단어가 충분한 첫 음절. */
  prompts: Map<number, Set<string>>;
}

/** 기본 키 (kind, word) 로 최대 3행만 찾는다. */
export const LOOKUP_SQL = "SELECT kind FROM words WHERE kind IN ('standard', 'slang', 'banned') AND word = ?1";

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`${ms}ms 안에 끝나지 않았습니다`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function statsOf(rows: Array<{ kind: string; n: number }>): D1Stats {
  const stats: D1Stats = { standard: 0, slang: 0, banned: 0 };
  for (const row of rows) {
    if (row.kind === "standard" || row.kind === "slang" || row.kind === "banned") stats[row.kind] = Number(row.n) || 0;
  }
  return stats;
}

const STATS_SQL = "SELECT kind, n FROM dict_stats";

/** kind 별 단어 수(적재 스크립트가 계산해 둔 값). 테이블이 없으면 reject. */
export async function readD1Stats(db: D1Database): Promise<D1Stats> {
  const { results } = await db.prepare(STATS_SQL).all<{ kind: string; n: number }>();
  return statsOf(results);
}

export interface SnapshotOptions {
  /** 읽어 둘 단어 길이 모드(0 = 자유). */
  lengths: number[];
  /** 제시어로 쓰는 음절. 이 음절의 행만 읽는다(읽는 행 수 제한). */
  syllables: string[];
  /** 그 길이의 인정 단어가 이 수 이상인 음절만 제시어로 쓴다. */
  minWords?: number;
}

/** 단어 수·차단 목록·제시어 집합을 한 번의 왕복으로 읽는다. 조회 오류(테이블 없음 포함)는 reject. */
export async function loadD1Snapshot(db: D1Database, options: SnapshotOptions): Promise<D1Snapshot> {
  const { lengths, syllables, minWords = 2 } = options;
  if (!lengths.every((n) => Number.isInteger(n) && n >= 0)) throw new Error("단어 길이는 0 이상의 정수여야 합니다");
  if (!syllables.every(isHangulSyllable)) throw new Error("제시어는 한글 음절이어야 합니다");

  const prompts = new Map<number, Set<string>>(lengths.map((n) => [n, new Set<string>()]));
  const statements = [db.prepare(STATS_SQL), db.prepare("SELECT word FROM words WHERE kind = 'banned'")];
  if (lengths.length && syllables.length) {
    // 값은 위에서 검증한 정수·한글 음절뿐이라 그대로 넣는다(D1 바인딩 변수는 100개 제한).
    const inLengths = lengths.join(", ");
    const inSyllables = syllables.map((s) => `'${s}'`).join(", ");
    statements.push(
      db
        .prepare(
          `SELECT word_length, syllable FROM prompt_syllables WHERE word_length IN (${inLengths}) AND syllable IN (${inSyllables}) AND n >= ?1`,
        )
        .bind(minWords),
    );
  }
  const [statsRows, bannedRows, promptRows] = await db.batch<Record<string, unknown>>(statements);
  for (const row of (promptRows?.results ?? []) as Array<{ word_length: number; syllable: string }>) {
    prompts.get(row.word_length)?.add(row.syllable);
  }
  return {
    stats: statsOf(statsRows.results as Array<{ kind: string; n: number }>),
    banned: new Set((bannedRows.results as Array<{ word: string }>).map((r) => r.word)),
    prompts,
  };
}

/** D1 words 테이블로 판정한다. 조회 오류는 `error: true` 로 돌려주어 호출부가 기존 경로로 넘기게 한다. */
export class D1Dictionary implements Dictionary {
  readonly name = "d1";

  constructor(
    private readonly db: D1Database,
    private readonly prompts: ReadonlyMap<number, Set<string>> = new Map(),
    private readonly timeoutMs = 1500,
  ) {}

  async isNoun(word: string): Promise<Verdict> {
    let kinds: string[];
    try {
      const { results } = await withTimeout(this.db.prepare(LOOKUP_SQL).bind(word).all<{ kind: string }>(), this.timeoutMs);
      kinds = results.map((r) => r.kind);
    } catch (err) {
      console.warn("D1 조회 실패", JSON.stringify({ word, error: String((err as Error)?.message ?? err).slice(0, 120) }));
      return { valid: false, reason: REASON_LOOKUP_FAILED, error: true };
    }
    if (kinds.includes("banned")) return { valid: false, reason: REASON_BANNED };
    if (kinds.length) return { valid: true }; // standard 또는 slang
    return { valid: false, reason: REASON_NOT_FOUND };
  }

  /** DO 초기화 때 읽어 둔 값을 동기 반환한다. 읽어 두지 않은 길이는 null(전체 목록). */
  promptSyllables(wordLength: number): Set<string> | null {
    return this.prompts.get(wordLength) ?? null;
  }
}

export type D1Report = { status: "unbound" | "error" } | ({ status: "empty" | "ready" } & D1Stats);

/**
 * /healthz 용. `ready` = 인정 단어(standard+slang)가 있어 D1 이 판정에 쓰인다.
 * `empty` = 인정 단어가 없어 기존 경로로 판정한다(차단 단어만 있을 수 있다).
 */
export class D1Health {
  private cached: { at: number; report: D1Report } | null = null;

  constructor(
    readonly db: D1Database | undefined,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 1500,
  ) {}

  async report(): Promise<D1Report> {
    if (!this.db) return { status: "unbound" };
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.report;
    let report: D1Report;
    try {
      const stats = await withTimeout(readD1Stats(this.db), this.timeoutMs);
      report = { status: stats.standard + stats.slang > 0 ? "ready" : "empty", ...stats };
    } catch (err) {
      console.warn("D1 상태 조회 실패", String((err as Error)?.message ?? err).slice(0, 120));
      report = { status: "error" };
    }
    this.cached = { at: this.now(), report };
    return report;
  }
}
