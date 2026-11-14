#!/usr/bin/env node
/**
 * 단어 목록(텍스트/CSV) → SQL 배치 파일 → `wrangler d1 execute --file` 로 D1(words)에 적재한다.
 * 적재 뒤 prompt_syllables(길이별 첫 음절 단어 수)와 dict_stats(kind 별 단어 수)를 다시 계산한다.
 *
 * 순수 함수(parseWords, buildSqlFiles, recalcSql, parseArgs)는 테스트에서 import 한다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const KINDS = ["standard", "slang", "banned"];
export const DEFAULT_DB = "word-rush-dict";
export const DEFAULT_OUT = ".wrangler/dict-load";

export const EXIT_OK = 0;
export const EXIT_INPUT = 1; // 입력 파일을 읽을 수 없거나 적재할 단어가 없다
export const EXIT_USAGE = 2; // 옵션이 잘못됐다
export const EXIT_WRANGLER = 3; // wrangler d1 execute 실패

const HELP = `단어 목록을 D1 단어 DB(words)에 적재한다.

사용법
  node scripts/dict/load.mjs <파일...> --kind <종류> (--local | --remote | --dry-run) [옵션]
  node scripts/dict/load.mjs --recalc-only (--local | --remote | --dry-run)

입력 형식 (확장자로 구분, --format 으로 강제 가능)
  .txt   한 줄에 한 단어 이상(공백 구분). '#' 으로 시작하는 줄은 주석. --kind 필수
  .csv   머리글 줄 word[,kind][,source][,pos]. kind 열이 없거나 비면 --kind 를 쓴다
         (따옴표·필드 안 쉼표는 지원하지 않는다)
  표제어 표기('-', '^', 공백)는 지우고, 한글 2글자 이상이 아닌 항목은 건너뛴다.

옵션
  --kind <standard|slang|banned>  standard=사전 명사, slang=유행어(인정), banned=차단
  --source <이름>      출처 표시 (기본: 파일 이름)
  --format <text|csv>  입력 형식 강제
  --replace            이번에 적재하는 (kind, source) 의 기존 행을 먼저 지운다 (목록 파일을 원본으로 맞출 때)
                       같은 kind 의 두 출처에 모두 있는 단어는 나중에 적재한 출처로 표시된다
  --recalc-only        단어는 넣지 않고 prompt_syllables·dict_stats 만 다시 계산한다
  --local              로컬 D1 (wrangler dev 용, .wrangler/state)
  --remote             운영 D1
  --dry-run            SQL 파일만 만들고 wrangler 를 실행하지 않는다
  --db <이름>          D1 이름 또는 바인딩 (기본: ${DEFAULT_DB})
  --out <디렉터리>     SQL 파일을 쓸 곳 (기본: ${DEFAULT_OUT})
  --rows-per-file <n>  SQL 파일 하나에 담을 행 수 (기본: 50000)
  --persist-to <경로>  --local 일 때 wrangler 에 그대로 전달
  -h, --help           이 도움말

출력
  stdout  만든 SQL 파일 경로(한 줄에 하나)
  stderr  진행 상황, 건너뛴 항목, wrangler 출력

종료 코드
  0 성공 · 1 입력 오류(파일 없음·적재할 단어 없음) · 2 사용법 오류 · 3 wrangler 실행 실패

예
  node scripts/dict/load.mjs test/fixtures/dict-words.csv --local
  node scripts/dict/load.mjs data/dict/banned.txt --kind banned --source banned --replace --remote
`;

// ── 한글 검증 (src/hangul.ts 와 같은 규칙. test/dict-load.test.ts 가 일치를 확인한다) ──

export function normalizeWord(word) {
  return String(word).trim().replace(/[-^ ]/g, "");
}

export function isHangulWord(word, minLen = 2) {
  return word.length >= minLen && /^[가-힣]+$/.test(word);
}

// ── 입력 파싱 ───────────────────────────────────────────────────

/**
 * @typedef {{ word: string, kind: string, source: string | null, pos: string | null }} WordRow
 * @typedef {{ line: number, value: string, why: string }} Skipped
 */

/**
 * @param {string} text
 * @param {{ format: "text" | "csv", kind?: string | null, source?: string | null }} options
 * @returns {{ rows: WordRow[], skipped: Skipped[] }}
 */
export function parseWords(text, options) {
  const { format, kind = null, source = null } = options;
  /** @type {WordRow[]} */
  const rows = [];
  /** @type {Skipped[]} */
  const skipped = [];
  let header = null;

  const push = (line, rawWord, rowKind, rowSource, pos) => {
    const word = normalizeWord(rawWord);
    if (!isHangulWord(word)) return void skipped.push({ line, value: rawWord, why: "한글 2글자 이상이 아님" });
    if (!KINDS.includes(rowKind)) return void skipped.push({ line, value: rawWord, why: `kind 가 올바르지 않음: ${rowKind ?? "(없음)"}` });
    rows.push({ word, kind: rowKind, source: rowSource || null, pos: pos || null });
  };

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) return;
    if (format === "text") {
      for (const token of line.split(/\s+/)) push(lineNo, token, kind, source, null);
      return;
    }
    const cells = line.split(",").map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      if (!header.includes("word")) throw new Error("CSV 머리글에 word 열이 없습니다");
      return;
    }
    const cell = (name) => {
      const i = header.indexOf(name);
      return i >= 0 ? (cells[i] ?? "") : "";
    };
    push(lineNo, cell("word"), cell("kind") || kind, cell("source") || source, cell("pos"));
  });
  return { rows, skipped };
}

/** 여러 파일의 파싱 결과를 한 배열로 모은다(수십만 행에서도 안전하게 — 전개 연산자로 push 하지 않는다). */
export function collectRows(parsedList) {
  const rows = [];
  for (const parsed of parsedList) for (const row of parsed.rows) rows.push(row);
  return rows;
}

/** 같은 (kind, word) 는 뒤에 나온 행이 이긴다. */
export function dedupe(rows) {
  const map = new Map();
  for (const row of rows) map.set(`${row.kind}\u0000${row.word}`, row);
  return [...map.values()];
}

// ── SQL 생성 ────────────────────────────────────────────────────

const q = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

/** prompt_syllables·dict_stats 를 words 에서 다시 계산한다. 차단 단어는 제시어 집계에서 뺀다. */
export function recalcSql() {
  return [
    "-- 길이별 첫 음절 단어 수 (차단 단어 제외). word_length = 0 은 모든 길이 합계(자유 모드).",
    "DELETE FROM prompt_syllables;",
    [
      "INSERT INTO prompt_syllables (word_length, syllable, n)",
      "SELECT length(word), substr(word, 1, 1), COUNT(*) FROM (",
      "  SELECT word FROM words WHERE kind IN ('standard', 'slang')",
      "  EXCEPT SELECT word FROM words WHERE kind = 'banned'",
      ") GROUP BY 1, 2;",
    ].join("\n"),
    [
      "INSERT INTO prompt_syllables (word_length, syllable, n)",
      "SELECT 0, syllable, SUM(n) FROM prompt_syllables WHERE word_length > 0 GROUP BY syllable;",
    ].join("\n"),
    "-- kind 별 단어 수 (항상 3행)",
    [
      "INSERT OR REPLACE INTO dict_stats (kind, n)",
      "SELECT k.kind, (SELECT COUNT(*) FROM words w WHERE w.kind = k.kind)",
      "FROM (SELECT 'standard' AS kind UNION ALL SELECT 'slang' UNION ALL SELECT 'banned') k;",
    ].join("\n"),
    "",
  ].join("\n");
}

/**
 * @param {WordRow[]} rows
 * @param {{ replace?: boolean, rowsPerFile?: number, rowsPerStatement?: number }} [options]
 * @returns {{ name: string, sql: string }[]} 실행 순서대로. 마지막은 항상 재계산 파일이다.
 *   replace 의 DELETE 는 첫 삽입 파일 맨 앞에 둔다: 따로 실행하면 그 사이 목록(특히 차단 목록)이 비어 버린다.
 */
export function buildSqlFiles(rows, options = {}) {
  const { replace = false, rowsPerFile = 50_000, rowsPerStatement = 200 } = options;
  const unique = dedupe(rows);
  const files = [];
  const pad = (n) => String(n).padStart(4, "0");

  const deletes = [];
  if (replace) {
    const pairs = new Map();
    for (const row of unique) pairs.set(`${row.kind}\u0000${row.source ?? ""}`, row);
    for (const row of pairs.values()) {
      deletes.push(
        row.source === null
          ? `DELETE FROM words WHERE kind = ${q(row.kind)} AND source IS NULL;`
          : `DELETE FROM words WHERE kind = ${q(row.kind)} AND source = ${q(row.source)};`,
      );
    }
  }

  for (let start = 0, fileNo = 1; start < unique.length; start += rowsPerFile, fileNo++) {
    const chunk = unique.slice(start, start + rowsPerFile);
    const statements = fileNo === 1 ? [...deletes] : [];
    for (let i = 0; i < chunk.length; i += rowsPerStatement) {
      const values = chunk
        .slice(i, i + rowsPerStatement)
        .map((row) => `(${q(row.word)}, ${q(row.kind)}, ${q(row.source)}, ${q(row.pos)})`)
        .join(",\n  ");
      statements.push(
        `INSERT INTO words (word, kind, source, pos) VALUES\n  ${values}\nON CONFLICT (kind, word) DO UPDATE SET source = excluded.source, pos = excluded.pos;`,
      );
    }
    files.push({ name: `${pad(fileNo)}-words.sql`, sql: `${statements.join("\n")}\n` });
  }

  files.push({ name: "9999-recalc.sql", sql: recalcSql() });
  return files;
}

// ── CLI ─────────────────────────────────────────────────────────

export class UsageError extends Error {}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = {
    files: [],
    kind: null,
    source: null,
    format: null,
    replace: false,
    recalcOnly: false,
    local: false,
    remote: false,
    dryRun: false,
    db: DEFAULT_DB,
    out: DEFAULT_OUT,
    rowsPerFile: 50_000,
    persistTo: null,
    help: false,
  };
  const valueOf = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} 에 값이 필요합니다`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--replace") opts.replace = true;
    else if (arg === "--recalc-only") opts.recalcOnly = true;
    else if (arg === "--local") opts.local = true;
    else if (arg === "--remote") opts.remote = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--kind") opts.kind = valueOf(arg, i++);
    else if (arg === "--source") opts.source = valueOf(arg, i++);
    else if (arg === "--format") opts.format = valueOf(arg, i++);
    else if (arg === "--db") opts.db = valueOf(arg, i++);
    else if (arg === "--out") opts.out = valueOf(arg, i++);
    else if (arg === "--persist-to") opts.persistTo = valueOf(arg, i++);
    else if (arg === "--rows-per-file") opts.rowsPerFile = Number.parseInt(valueOf(arg, i++), 10);
    else if (arg.startsWith("-")) throw new UsageError(`알 수 없는 옵션: ${arg}`);
    else opts.files.push(arg);
  }
  if (opts.help) return opts;
  if (opts.kind !== null && !KINDS.includes(opts.kind)) throw new UsageError(`--kind 는 ${KINDS.join("|")} 중 하나여야 합니다`);
  if (opts.format !== null && !["text", "csv"].includes(opts.format)) throw new UsageError("--format 은 text|csv 중 하나여야 합니다");
  if (!Number.isInteger(opts.rowsPerFile) || opts.rowsPerFile <= 0) throw new UsageError("--rows-per-file 은 양의 정수여야 합니다");
  if (opts.local && opts.remote) throw new UsageError("--local 과 --remote 는 함께 쓸 수 없습니다");
  if (!opts.dryRun && !opts.local && !opts.remote) throw new UsageError("--local, --remote, --dry-run 중 하나를 지정하세요");
  if (opts.persistTo && !opts.local) throw new UsageError("--persist-to 는 --local 과 함께 씁니다");
  if (opts.recalcOnly && opts.files.length) throw new UsageError("--recalc-only 는 파일 없이 씁니다");
  if (!opts.recalcOnly && !opts.files.length) throw new UsageError("적재할 파일을 지정하세요 (또는 --recalc-only)");
  return opts;
}

const formatOf = (file, forced) => forced ?? (extname(file).toLowerCase() === ".csv" ? "csv" : "text");

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`오류: ${err.message}\n'--help' 로 사용법을 확인하세요.`);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  const parsedList = [];
  for (const file of opts.files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      console.error(`오류: 파일을 읽을 수 없습니다: ${file} (${err.code ?? err.message})`);
      return EXIT_INPUT;
    }
    const format = formatOf(file, opts.format);
    if (format === "text" && !opts.kind) {
      console.error(`오류: 텍스트 파일(${file})에는 --kind 가 필요합니다`);
      return EXIT_USAGE;
    }
    let parsed;
    try {
      parsed = parseWords(text, { format, kind: opts.kind, source: opts.source ?? basename(file) });
    } catch (err) {
      console.error(`오류: ${file}: ${err.message}`);
      return EXIT_INPUT;
    }
    parsedList.push(parsed);
    console.error(`${file}: ${parsed.rows.length}행 읽음, ${parsed.skipped.length}건 건너뜀`);
    for (const s of parsed.skipped.slice(0, 10)) console.error(`  건너뜀 ${s.line}행 '${s.value}': ${s.why}`);
    if (parsed.skipped.length > 10) console.error(`  ... 외 ${parsed.skipped.length - 10}건`);
  }
  const rows = collectRows(parsedList);
  if (!opts.recalcOnly && !rows.length) {
    console.error("오류: 적재할 단어가 없습니다");
    return EXIT_INPUT;
  }

  const files = buildSqlFiles(rows, { replace: opts.replace, rowsPerFile: opts.rowsPerFile });
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const row of dedupe(rows)) counts[row.kind] += 1;
  console.error(`적재 대상(중복 제거 후): ${KINDS.map((k) => `${k} ${counts[k]}`).join(", ")}`);

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  for (const old of readdirSync(outDir)) {
    if (/^\d{4}-(words|recalc)\.sql$/.test(old)) rmSync(join(outDir, old)); // 이전 실행이 남긴 배치만 지운다
  }
  const paths = files.map((file) => {
    const path = join(outDir, file.name);
    writeFileSync(path, file.sql);
    return path;
  });
  for (const path of paths) process.stdout.write(`${path}\n`);

  if (opts.dryRun) {
    console.error(`dry-run: SQL 파일 ${paths.length}개만 만들었습니다 (wrangler 실행 안 함)`);
    return EXIT_OK;
  }

  const target = opts.remote ? "--remote" : "--local";
  for (const path of paths) {
    const args = ["wrangler", "d1", "execute", opts.db, target, "--file", path, "--yes"];
    if (opts.persistTo) args.push("--persist-to", opts.persistTo);
    console.error(`실행: npx ${args.join(" ")}`);
    const result = spawnSync("npx", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    if (result.stdout) process.stderr.write(result.stdout); // stdout 은 파일 목록 전용
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      console.error(`오류: wrangler d1 execute 실패 (${path}) — 같은 명령을 다시 실행하면 된다(INSERT 는 덮어쓰기)`);
      return EXIT_WRANGLER;
    }
  }
  console.error(`완료: ${target.slice(2)} D1 '${opts.db}' 에 적재하고 prompt_syllables·dict_stats 를 다시 계산했습니다`);
  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
