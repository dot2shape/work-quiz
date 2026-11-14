#!/usr/bin/env node
/**
 * 실행 중인 서버(wrangler dev 등)에 WebSocket 으로 방을 만들어 판정 경로를 확인한다.
 *
 *   --expect d1    fixture 를 적재한 D1: 차단 거절·유행어 인정·D1 에 없는 시드 단어 인정·없는 단어 거절
 *   --expect seed  빈 D1(또는 D1 없음): 시드 단어 인정, fixture 유행어는 "사전에 없는 단어"
 *                  (STDICT_API_KEY 없이 띄운 서버 기준 — 키가 있으면 판정이 stdict 로 가므로 맞지 않는다)
 *
 * 제시어가 무작위라 여러 방을 동시에 돌려 필요한 경우가 모두 나올 때까지 라운드를 진행한다.
 * 종료 코드: 0 모두 확인 · 1 기대와 다른 판정 또는 시간 초과 · 2 사용법 오류
 */
import { readFileSync } from "node:fs";
import { parseWords } from "./load.mjs";

const HELP = `사용법: node scripts/dict/smoke.mjs --expect <d1|seed> [--url http://localhost:8787] [--rooms 6] [--timeout 240]
  --fixture <파일[,파일...]>  D1 에 적재한 목록. CSV 또는 '# kind:' 지시문이 있는 텍스트 (기본: test/fixtures/dict-words.csv)
                   예: --fixture data/dict/slang.txt,data/dict/banned.txt
  --seed <txt>     시드 목록 (기본: data/seed_words.txt)
서버는 TARGET_SCORE 를 크게 띄우면 빨리 끝난다: npx wrangler dev --var TARGET_SCORE:1000
`;

const REASON_BANNED = "사용할 수 없는 단어입니다";
const REASON_NOT_FOUND = "사전에 없는 단어입니다";

function parseArgs(argv) {
  const opts = { url: "http://localhost:8787", expect: null, rooms: 6, timeout: 240, fixture: "test/fixtures/dict-words.csv", seed: "data/seed_words.txt" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true };
    const key = { "--url": "url", "--expect": "expect", "--rooms": "rooms", "--timeout": "timeout", "--fixture": "fixture", "--seed": "seed" }[arg];
    if (!key || argv[i + 1] === undefined) throw new Error(`알 수 없는 옵션이거나 값이 없습니다: ${arg}`);
    opts[key] = key === "rooms" || key === "timeout" ? Number(argv[++i]) : argv[++i];
  }
  if (!["d1", "seed"].includes(opts.expect)) throw new Error("--expect 는 d1|seed 중 하나여야 합니다");
  return opts;
}

/** 메시지를 쌓아 두고 조건에 맞는 것을 기다리는 WebSocket 클라이언트. */
class Client {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`접속 실패: ${url}`)), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.queue.push(msg);
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  next(match, timeoutMs = 30_000) {
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (m) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("응답 시간 초과"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  type(t, timeoutMs) {
    return this.next((m) => m.type === t, timeoutMs);
  }
  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byFirst = (words) => {
  const map = new Map();
  for (const w of words) map.set(w[0], [...(map.get(w[0]) ?? []), w]);
  return map;
};

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`오류: ${err.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) return process.stdout.write(HELP), 0;

  const fixture = opts.fixture
    .split(",")
    .flatMap((file) => parseWords(readFileSync(file, "utf8"), { format: file.toLowerCase().endsWith(".csv") ? "csv" : "text" }).rows);
  const seed = parseWords(readFileSync(opts.seed, "utf8"), { format: "text", kind: "standard" }).rows.map((r) => r.word);
  const banned = new Set(fixture.filter((r) => r.kind === "banned").map((r) => r.word));
  const slang = fixture.filter((r) => r.kind === "slang" && !banned.has(r.word)).map((r) => r.word);
  const inD1 = new Set(fixture.filter((r) => r.kind !== "banned").map((r) => r.word));
  const seedOnly = seed.filter((w) => !inD1.has(w) && !banned.has(w));
  const maps = { banned: byFirst(banned), slang: byFirst(slang), seedOnly: byFirst(seedOnly), seed: byFirst(seed.filter((w) => !banned.has(w))) };

  const need = opts.expect === "d1" ? ["차단 거절", "유행어 인정", "D1에 없는 시드 단어 인정", "없는 단어 거절"] : ["시드 단어 인정", "유행어 거절(D1 비어 있음)"];
  const covered = new Map(); // 항목 → 근거
  const failures = [];
  const done = () => failures.length > 0 || need.every((k) => covered.has(k));
  const wsBase = opts.url.replace(/^http/, "ws");

  const health = await (await fetch(`${opts.url}/healthz`)).json();
  console.log(`healthz ${JSON.stringify(health)}`);
  const wantDictionary = opts.expect === "d1" ? "d1" : "local";
  if (health.dictionary !== wantDictionary) failures.push(`healthz.dictionary = ${health.dictionary} (기대 ${wantDictionary})`);

  async function room(no) {
    const host = new Client(`${wsBase}/ws`);
    await host.opened;
    host.send({ type: "create_room", nickname: `검사${no}` });
    const { code } = await host.type("joined");
    const guest = new Client(`${wsBase}/ws?code=${code}`);
    await guest.opened;
    guest.send({ type: "join_room", nickname: `손님${no}` });
    await guest.type("joined");
    const state = await host.next((m) => m.type === "room_state" && m.players.length === 2);
    if (state.dictionary_mode !== wantDictionary) failures.push(`방 ${code} dictionary_mode = ${state.dictionary_mode} (기대 ${wantDictionary})`);
    host.send({ type: "start_game" });

    /** 한 단어를 내고 판정을 받는다. 기대와 다르면 실패로 기록한다. */
    const submit = async (label, word, check) => {
      host.send({ type: "submit_word", word });
      const result = await host.type("submit_result");
      const ok = check(result);
      const evidence = `방 ${code} '${word}' → ${result.accepted ? "인정" : `거절(${result.reason}, 쿨다운 ${result.cooldown_ms}ms)`}`;
      if (!ok) failures.push(`${label}: ${evidence}`);
      else if (!covered.has(label)) covered.set(label, evidence);
      if (!result.accepted) await sleep(Number(result.cooldown_ms) + 100);
      return result.accepted;
    };
    const rejectedAs = (reason, cooldown) => (r) => r.accepted === false && r.reason === reason && (!cooldown || r.cooldown_ms > 0);
    const accepted = (r) => r.accepted === true;

    try {
      while (!done()) {
        const msg = await host.next((m) => m.type === "round_start" || m.type === "game_over", 60_000);
        if (msg.type === "game_over") {
          host.send({ type: "restart_game" });
          await sleep(200);
          host.send({ type: "start_game" });
          continue;
        }
        const p = msg.prompt;
        if (opts.expect === "d1") {
          if (!covered.has("차단 거절") && maps.banned.has(p)) await submit("차단 거절", maps.banned.get(p)[0], rejectedAs(REASON_BANNED, true));
          if (!covered.has("없는 단어 거절")) await submit("없는 단어 거절", `${p}뷁뷁`, rejectedAs(REASON_NOT_FOUND, true));
          if (!covered.has("유행어 인정") && maps.slang.has(p)) await submit("유행어 인정", maps.slang.get(p)[0], accepted);
          else if (maps.seedOnly.has(p)) await submit("D1에 없는 시드 단어 인정", maps.seedOnly.get(p)[0], accepted);
        } else {
          if (maps.slang.has(p)) await submit("유행어 거절(D1 비어 있음)", maps.slang.get(p)[0], rejectedAs(REASON_NOT_FOUND, true));
          if (maps.seed.has(p)) await submit("시드 단어 인정", maps.seed.get(p)[0], accepted);
        }
        await host.type("round_end", 60_000);
      }
    } finally {
      host.close();
      guest.close();
    }
  }

  const deadline = sleep(opts.timeout * 1000).then(() => failures.push(`시간 초과(${opts.timeout}초): 확인 못 한 항목 ${need.filter((k) => !covered.has(k)).join(", ")}`));
  const rooms = Array.from({ length: opts.rooms }, (_, i) => room(i + 1).catch((err) => failures.push(`방 ${i + 1}: ${err.message}`)));
  await Promise.race([Promise.all(rooms), deadline]);

  for (const key of need) console.log(`${covered.has(key) ? "확인" : "미확인"} ${key}: ${covered.get(key) ?? "-"}`);
  for (const f of failures) console.error(`실패 ${f}`);
  return failures.length || !need.every((k) => covered.has(k)) ? 1 : 0;
}

main().then((code) => process.exit(code));
