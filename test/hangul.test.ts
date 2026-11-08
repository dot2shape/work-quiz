import { describe, expect, it } from "vitest";
import { isHangulSyllable, isHangulWord, normalize } from "../src/hangul";

describe("hangul", () => {
  it("완성형 음절만 인정한다", () => {
    expect(isHangulSyllable("가")).toBe(true);
    expect(isHangulSyllable("힣")).toBe(true);
    expect(isHangulSyllable("ㄱ")).toBe(false);
    expect(isHangulSyllable("a")).toBe(false);
    expect(isHangulSyllable("가나")).toBe(false);
  });

  it("2글자 이상 한글 단어만 통과한다", () => {
    expect(isHangulWord("부산")).toBe(true);
    expect(isHangulWord("부")).toBe(false);
    expect(isHangulWord("부san")).toBe(false);
    expect(isHangulWord("부 산")).toBe(false);
    expect(isHangulWord("")).toBe(false);
  });

  it("표제어 표기 기호와 공백을 제거한다", () => {
    expect(normalize(" 부산-물 ")).toBe("부산물");
    expect(normalize("부산^역")).toBe("부산역");
    expect(normalize("부 산")).toBe("부산");
  });
});
