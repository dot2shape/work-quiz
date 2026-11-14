/** Worker/Durable Object 가 공유하는 바인딩 타입. wrangler.toml 과 일치해야 한다. */
import type { SettingsEnv } from "./settings";

export interface Env extends SettingsEnv {
  ROOMS: DurableObjectNamespace;
  DICT_CACHE: KVNamespace;
  /** 자체 단어 DB(D1). 바인딩이 없거나 비어 있으면 기존 경로(stdict → 시드)로 판정한다. */
  DICT_DB?: D1Database;
  ASSETS: Fetcher;
  /** `wrangler secret put STDICT_API_KEY` 로만 설정한다. 없으면 로컬 사전 모드. */
  STDICT_API_KEY?: string;
}

/** 방 코드 문자 집합. 혼동되는 문자(0 O 1 I)를 뺐다. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(length = 6): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}
