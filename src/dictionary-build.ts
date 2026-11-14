/**
 * 방(DO) 하나가 쓸 사전을 조립한다.
 *
 *   차단 층(BlocklistDictionary)                    ← D1 의 banned 목록. 어떤 경로든 판정 앞에서 거절
 *     └ TieredDictionary                            ← D1 에 인정 단어가 있을 때만
 *         ├ D1Dictionary (메모리 캐시)
 *         └ 기존 경로: FallbackDictionary(stdict + KV 캐시 → 시드) 또는 시드
 *
 * D1 바인딩이 없거나, 비어 있거나, 초기화 조회가 실패·지연되면 기존 경로만 쓴다.
 */
import { D1Dictionary, loadD1Snapshot, withTimeout } from "./d1-dictionary";
import {
  BlocklistDictionary,
  CachedDictionary,
  type Dictionary,
  FallbackDictionary,
  LocalDictionary,
  StdictClient,
  TieredDictionary,
} from "./dictionary";
import type { Env } from "./env";
import { PROMPT_SYLLABLES } from "./prompts";
import { WORD_LENGTH_MODES } from "./room";

export interface BuildOptions {
  /** 테스트용 stdict fetch 대역. */
  fetchImpl?: typeof fetch;
  /** DO 초기화를 붙잡아 둘 수 있는 최대 시간. 넘으면 기존 경로로 시작한다. */
  initTimeoutMs?: number;
}

type BuildEnv = Pick<Env, "STDICT_API_KEY" | "DICT_CACHE" | "DICT_DB">;

/** 기존 경로(#9): 키가 있으면 stdict → 시드 폴백, 없으면 시드. 동기라서 초기화가 실패해도 쓸 수 있다. */
export function buildBaseDictionary(env: BuildEnv, seedText: string, options: BuildOptions = {}): Dictionary {
  const local = LocalDictionary.fromText(seedText);
  const key = env.STDICT_API_KEY?.trim();
  if (!key) return local;
  // stdict 조회 실패 시 거절하지 않고 시드로 폴백한다. 폴백 판정은 KV 에 캐시되지 않는다.
  const stdict = new CachedDictionary(new StdictClient(key, options.fetchImpl), env.DICT_CACHE);
  return new FallbackDictionary(stdict, local, { shared: env.DICT_CACHE });
}

/** DO 초기화(`blockConcurrencyWhile`) 안에서 한 번 부른다. 어떤 경우에도 reject 하지 않는다. */
export async function buildDictionary(env: BuildEnv, seedText: string, options: BuildOptions = {}): Promise<Dictionary> {
  const base = buildBaseDictionary(env, seedText, options);
  const db = env.DICT_DB;
  const lengths = Object.keys(WORD_LENGTH_MODES).map(Number);
  try {
    const [, snapshot] = await withTimeout(
      Promise.all([
        base instanceof FallbackDictionary ? base.syncShared() : null, // 다른 방이 남긴 stdict 차단 플래그
        db ? loadD1Snapshot(db, { lengths, syllables: PROMPT_SYLLABLES }) : null,
      ]),
      options.initTimeoutMs ?? 2000,
    );
    if (!db || !snapshot) return base;
    const hasWords = snapshot.stats.standard + snapshot.stats.slang > 0;
    const dictionary = hasWords
      ? new TieredDictionary(new CachedDictionary(new D1Dictionary(db, snapshot.prompts), null), base)
      : base; // 빈 DB: 기존 경로 그대로
    return snapshot.banned.size ? new BlocklistDictionary(dictionary, snapshot.banned) : dictionary;
  } catch (err) {
    console.warn("단어 DB 초기화 실패: 기존 경로로 판정", String((err as Error)?.message ?? err).slice(0, 120));
    return base;
  }
}
