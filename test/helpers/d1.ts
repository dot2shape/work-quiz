/** 테스트용 실제 D1(miniflare/workerd). wrangler dev 가 쓰는 것과 같은 구현이다. */
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildSqlFiles, parseWords } from "../../scripts/dict/load.mjs";
import migration from "../../migrations/0001_words.sql?raw";
import fixture from "../fixtures/dict-words.csv?raw";

export { fixture, migration };

/** 이름마다 빈 D1 데이터베이스를 하나씩 만든다. */
export async function createDatabases<K extends string>(names: readonly K[]): Promise<{ dbs: Record<K, D1Database>; dispose: () => Promise<void> }> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-10-01",
      d1Databases: Object.fromEntries(names.map((n) => [n, `test-${n}`])),
    }),
  );
  const dbs = {} as Record<K, D1Database>;
  for (const name of names) dbs[name] = (await mf.getD1Database(name)) as unknown as D1Database;
  return { dbs, dispose: () => mf.dispose() };
}

/** 여러 문장이 든 SQL 파일을 실행한다(`--` 주석 줄 제거, `;` 줄 끝 기준 분리). */
export async function runSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

export const migrate = (db: D1Database) => runSql(db, migration);

/** 적재 스크립트가 만드는 SQL 그대로 넣는다. */
export async function load(db: D1Database, text: string, options: { format: "text" | "csv"; kind?: string; source?: string; replace?: boolean }): Promise<void> {
  const { rows } = parseWords(text, options);
  for (const file of buildSqlFiles(rows, { replace: options.replace })) await runSql(db, file.sql);
}

export const loadFixture = (db: D1Database) => load(db, fixture, { format: "csv" });
