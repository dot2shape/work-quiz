/** 한글 단어 형식 검증 유틸리티. */

const HANGUL_START = 0xac00; // 가
const HANGUL_END = 0xd7a3; // 힣

export function isHangulSyllable(ch: string): boolean {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= HANGUL_START && code <= HANGUL_END;
}

/** 완성형 한글 음절만으로 이루어진 minLen자 이상의 문자열인지 확인한다. */
export function isHangulWord(word: string, minLen = 2): boolean {
  if (word.length < minLen) return false;
  for (const ch of word) if (!isHangulSyllable(ch)) return false;
  return true;
}

/** 사전 표제어 표기(붙임표 '-', 띄어쓰기 표시 '^')와 공백을 제거한다. */
export function normalize(word: string): string {
  return word.trim().replace(/[-^ ]/g, "");
}
