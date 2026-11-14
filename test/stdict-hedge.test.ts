/**
 * #24: stdict 응답이 늦으면 두 번째 요청을 병행(hedge)하고, 전체 한도 안에 먼저 온 성공 응답으로 판정한다.
 *
 * 운영 측정(2026-11-15): 방(DO) 안의 stdict 조회 38건 중 4건이 3초 timeout 에 걸렸고(첫 조회만이 아님),
 * 같은 단어를 다시 조회하면 정상이었다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STDICT_HEDGE_AFTER_MS, STDICT_TIMEOUT_MS, StdictClient } from "../src/dictionary";

type Step = { after: number; respond: () => Response } | "hang";

/** 호출 순서대로 계획된 응답을 돌려주는 fetch 대역. 취소(abort)를 지킨다. */
function plannedFetch(plan: Step[]) {
  const calls: Array<{ aborted: boolean; done: boolean }> = [];
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const step = plan[calls.length] ?? "hang";
    const call = { aborted: false, done: false };
    calls.push(call);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer =
        step === "hang"
          ? null
          : setTimeout(() => {
              call.done = true;
              resolve(step.respond());
            }, step.after);
      const onAbort = () => {
        if (call.done) return;
        if (timer) clearTimeout(timer);
        call.aborted = true;
        reject(signal!.reason);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noun = (word: string) => () => Response.json({ channel: { item: [{ word, pos: "명사" }] } });
const HEDGE = 30;
const TIMEOUT = 150;
const client = (fetchImpl: typeof fetch) => new StdictClient("SECRETKEY1234567890", fetchImpl, TIMEOUT, HEDGE);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function captureWarn(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  return logs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StdictClient — 지연 시 병행 요청 (#24)", () => {
  it("기본값: 1.5초 뒤 병행, 전체 한도 5초", () => {
    expect(STDICT_HEDGE_AFTER_MS).toBe(1500);
    expect(STDICT_TIMEOUT_MS).toBe(5000);
    expect(STDICT_HEDGE_AFTER_MS).toBeLessThan(STDICT_TIMEOUT_MS);
  });

  it("제때 응답하면 요청은 한 번뿐이고 로그도 없다", async () => {
    const logs = captureWarn();
    const { fetchImpl, calls } = plannedFetch([{ after: 5, respond: noun("미나리") }]);
    expect(await client(fetchImpl).isNoun("미나리")).toEqual({ valid: true });
    await settle(HEDGE + 20);
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("첫 요청이 늦으면 두 번째 요청을 병행해 그 응답으로 판정하고, 늦은 요청은 취소한다", async () => {
    const logs = captureWarn();
    const { fetchImpl, calls } = plannedFetch(["hang", { after: 5, respond: noun("미나리") }]);
    const started = Date.now();
    expect(await client(fetchImpl).isNoun("미나리")).toEqual({ valid: true });
    expect(Date.now() - started).toBeLessThan(TIMEOUT); // 전체 한도까지 기다리지 않는다
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[0].aborted).toBe(true);
    // 회복된 지연은 진단용으로 남긴다(키는 남기지 않는다)
    const out = logs.join("\n");
    expect(out).toContain("stdict 조회 지연");
    expect(out).toContain('"attempts":2');
    expect(out).toContain('"winner":2');
    expect(out).not.toContain("SECRET");
  });

  it("병행한 뒤 첫 요청이 먼저 성공하면 그 응답을 쓰고 두 번째를 취소한다", async () => {
    captureWarn();
    const { fetchImpl, calls } = plannedFetch([{ after: HEDGE + 20, respond: noun("미나리") }, "hang"]);
    expect(await client(fetchImpl).isNoun("미나리")).toEqual({ valid: true });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].aborted).toBe(true);
  });

  it("병행한 요청 하나가 실패해도 다른 하나가 성공하면 인정한다", async () => {
    captureWarn();
    const { fetchImpl, calls } = plannedFetch([
      { after: HEDGE + 40, respond: noun("미나리") },
      { after: 5, respond: () => new Response("boom", { status: 500 }) },
    ]);
    expect(await client(fetchImpl).isNoun("미나리")).toEqual({ valid: true });
    expect(calls).toHaveLength(2);
  });

  it("둘 다 전체 한도까지 응답이 없으면 timeout 으로 조회 실패(error)다", async () => {
    const logs = captureWarn();
    const { fetchImpl, calls } = plannedFetch(["hang", "hang"]);
    const started = Date.now();
    const verdict = await client(fetchImpl).isNoun("미나리");
    const elapsed = Date.now() - started;
    expect(verdict).toMatchObject({ valid: false, error: true });
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 10);
    expect(elapsed).toBeLessThan(TIMEOUT + 200);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.aborted)).toBe(true);
    const out = logs.join("\n");
    expect(out).toContain("stdict 조회 실패");
    expect(out).toContain('"kind":"timeout"');
    expect(out).toContain('"attempts":2');
    expect(out).not.toContain("SECRET");
  });

  it("한도 초과가 TimeoutError 가 아닌 취소 오류로 와도 timeout 으로 분류한다", async () => {
    const logs = captureWarn();
    // 취소되면 사유와 무관하게 AbortError 를 던지는 런타임 대역
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as typeof fetch;
    expect(await client(fetchImpl).isNoun("미나리")).toMatchObject({ valid: false, error: true });
    expect(logs.join("\n")).toContain('"kind":"timeout"');
  });

  it("첫 요청이 병행 전에 실패하면(HTTP 오류·빈 본문) 다시 보내지 않고 바로 조회 실패다", async () => {
    captureWarn();
    const failed = plannedFetch([{ after: 5, respond: () => new Response("boom", { status: 500 }) }]);
    expect(await client(failed.fetchImpl).isNoun("미나리")).toMatchObject({ valid: false, error: true });
    const empty = plannedFetch([{ after: 5, respond: () => new Response("", { status: 200 }) }]); // 키 오류 응답
    expect(await client(empty.fetchImpl).isNoun("미나리")).toMatchObject({ valid: false, error: true });
    await settle(HEDGE + 20);
    expect(failed.calls).toHaveLength(1);
    expect(empty.calls).toHaveLength(1);
  });

  it("병행 간격을 0 으로 주면 병행하지 않는다", async () => {
    captureWarn();
    const { fetchImpl, calls } = plannedFetch(["hang", "hang"]);
    const single = new StdictClient("test-key", fetchImpl, 60, 0);
    expect(await single.isNoun("미나리")).toMatchObject({ valid: false, error: true });
    expect(calls).toHaveLength(1);
  });
});
