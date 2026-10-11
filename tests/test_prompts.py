from app.prompts import PROMPT_SYLLABLES, PromptPicker


def test_syllables_are_single_hangul():
    assert len(PROMPT_SYLLABLES) >= 40
    assert len(set(PROMPT_SYLLABLES)) == len(PROMPT_SYLLABLES)
    assert all(len(s) == 1 and "가" <= s <= "힣" for s in PROMPT_SYLLABLES)


def test_no_repeat_until_exhausted():
    picker = PromptPicker()
    used: set[str] = set()
    for _ in range(len(PROMPT_SYLLABLES)):
        s = picker.next(used)
        assert s not in used
        used.add(s)
    # 소진 후에는 재사용을 허용한다
    assert picker.next(used) in PROMPT_SYLLABLES
