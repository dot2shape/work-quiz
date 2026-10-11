"""한글 단어 형식 검증 유틸리티."""
from __future__ import annotations

_HANGUL_START = 0xAC00  # 가
_HANGUL_END = 0xD7A3  # 힣


def is_hangul_syllable(ch: str) -> bool:
    return len(ch) == 1 and _HANGUL_START <= ord(ch) <= _HANGUL_END


def is_hangul_word(word: str, min_len: int = 2) -> bool:
    """완성형 한글 음절만으로 이루어진 min_len자 이상의 문자열인지 확인한다."""
    if len(word) < min_len:
        return False
    return all(is_hangul_syllable(ch) for ch in word)


def normalize(word: str) -> str:
    """사전 표제어 표기(붙임표 '-', 띄어쓰기 표시 '^')와 공백을 제거한다."""
    return word.strip().replace("-", "").replace("^", "").replace(" ", "")
