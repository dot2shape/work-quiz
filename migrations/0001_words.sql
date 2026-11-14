-- 자체 단어 DB (#12). 적재는 scripts/dict/load.mjs 로만 한다.
--
-- words: 한 단어가 kind 별로 한 행씩 가질 수 있다(예: 사전에 명사로 있으면서 차단 목록에도 있는 단어).
--   기본 키가 (kind, word) 라서 차단 목록을 갈아 끼워도 사전 행이 지워지지 않는다.
--   판정 조회는 `kind IN (...) AND word = ?` 로 최대 3행만 읽는다.
CREATE TABLE IF NOT EXISTS words (
  word   TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('standard', 'slang', 'banned')),
  source TEXT,
  pos    TEXT,
  PRIMARY KEY (kind, word)
) WITHOUT ROWID;

-- 길이별 첫 음절의 인정 단어 수. word_length = 0 은 자유 모드(모든 길이 합계).
-- 적재 스크립트가 다시 계산한다(차단 단어 제외).
CREATE TABLE IF NOT EXISTS prompt_syllables (
  word_length INTEGER NOT NULL,
  syllable    TEXT NOT NULL,
  n           INTEGER NOT NULL,
  PRIMARY KEY (word_length, syllable)
) WITHOUT ROWID;

-- kind 별 단어 수. /healthz 와 DO 초기화가 words 전체를 세지 않도록 적재 스크립트가 다시 계산한다.
CREATE TABLE IF NOT EXISTS dict_stats (
  kind TEXT PRIMARY KEY,
  n    INTEGER NOT NULL
) WITHOUT ROWID;
