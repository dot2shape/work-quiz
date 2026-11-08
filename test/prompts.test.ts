import { describe, expect, it } from "vitest";
import { PROMPT_SYLLABLES, PromptPicker } from "../src/prompts";

describe("PromptPicker", () => {
  it("사용한 음절을 피한다", () => {
    const picker = new PromptPicker(() => 0, ["가", "나", "다"]);
    const used = new Set<string>();
    expect(picker.next(used)).toBe("가");
    used.add("가");
    expect(picker.next(used)).toBe("나");
    used.add("나");
    expect(picker.next(used)).toBe("다");
  });

  it("모두 소진되면 재사용을 허용한다", () => {
    const picker = new PromptPicker(() => 0, ["가", "나"]);
    expect(picker.next(new Set(["가", "나"]))).toBe("가");
  });

  it("pool 이 주어지면 그 안에서만 뽑고, 비면 전체로 돌아간다", () => {
    const picker = new PromptPicker(() => 0, ["가", "나", "다"]);
    expect(picker.next(new Set(), new Set(["다"]))).toBe("다");
    expect(picker.next(new Set(), new Set(["없"]))).toBe("가");
  });

  it("기본 목록은 중복이 없고 모두 한 음절이다", () => {
    expect(new Set(PROMPT_SYLLABLES).size).toBe(PROMPT_SYLLABLES.length);
    for (const s of PROMPT_SYLLABLES) expect([...s].length).toBe(1);
  });
});
