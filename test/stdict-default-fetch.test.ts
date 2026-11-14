import { afterEach, describe, expect, it, vi } from "vitest";
import { StdictClient } from "../src/dictionary";

/**
 * #19 회귀: Workers 런타임의 전역 fetch 는 `this` 가 globalThis(또는 undefined)가 아니면
 * `TypeError: Illegal invocation` 을 던진다. fetch 를 주입하지 않은 기본 경로가
 * 객체 메서드 호출(`this.fetchImpl(...)`)의 `this` 에 의존하지 않아야 한다.
 */
describe("StdictClient 기본 fetch 경로 (#19)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("전역 fetch 를 this 바인딩 없이 호출한다", async () => {
    const receivers: unknown[] = [];
    // Workers 전역 fetch 대역: 수신 객체가 잘못되면 실제 런타임처럼 던진다.
    const strictFetch = function (this: unknown, _input: RequestInfo | URL): Promise<Response> {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ channel: { total: 1, item: [{ word: "사과", pos: "명사" }] } }));
    };
    vi.stubGlobal("fetch", strictFetch);

    const client = new StdictClient("test-key"); // fetch 주입 없음 = 운영 경로
    expect(await client.isNoun("사과")).toEqual({ valid: true });
    expect(receivers).toHaveLength(1);
  });
});
