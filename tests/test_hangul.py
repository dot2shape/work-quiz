from app.hangul import is_hangul_word, normalize


def test_valid():
    assert is_hangul_word("부산")


def test_single_syllable_rejected():
    assert not is_hangul_word("부")


def test_non_hangul_rejected():
    assert not is_hangul_word("bus")


def test_mixed_rejected():
    assert not is_hangul_word("부a")


def test_empty_rejected():
    assert not is_hangul_word("")


def test_normalize_strips_marks():
    assert normalize(" 부산-물^ ") == "부산물"
