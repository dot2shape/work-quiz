"""제시어(첫 음절) 선별 목록과 추출기.

명사가 충분히 많은 음절만 모았다. 단어가 거의 없는 음절(예: '뷁')은 제외한다.
"""
from __future__ import annotations

import random

PROMPT_SYLLABLES: list[str] = [
    "가", "강", "개", "거", "경", "고", "공", "교", "구", "국", "기",
    "나", "남", "노", "농",
    "다", "대", "도", "동", "두",
    "마", "만", "모", "무", "문", "미",
    "바", "반", "방", "배", "백", "보", "부", "분", "비",
    "사", "산", "상", "서", "석", "선", "설", "성", "세", "소", "수", "시", "식", "신", "실", "심",
    "아", "안", "양", "여", "연", "영", "오", "온", "우", "운", "원", "유", "은", "음", "의", "이", "인", "일", "입",
    "자", "장", "재", "저", "전", "정", "제", "조", "주", "중", "지", "진",
    "차", "천", "철", "청", "초", "출",
    "태", "토", "통",
    "표", "풍",
    "하", "학", "한", "해", "행", "현", "호", "화", "회", "후",
]


class PromptPicker:
    """같은 게임 안에서 제시어가 겹치지 않도록 뽑는다. 모두 소진되면 재사용을 허용한다."""

    def __init__(self, rng: random.Random | None = None, syllables: list[str] | None = None):
        self._rng = rng or random.Random()
        self._syllables = list(syllables or PROMPT_SYLLABLES)

    def next(self, used: set[str], pool: set[str] | None = None) -> str:
        """pool이 주어지면 그 안의 음절만 쓴다(단어 길이 모드별 제한)."""
        base = [s for s in self._syllables if pool is None or s in pool] or self._syllables
        candidates = [s for s in base if s not in used] or base
        return self._rng.choice(candidates)
