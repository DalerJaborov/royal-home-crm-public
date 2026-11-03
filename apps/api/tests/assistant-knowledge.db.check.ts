import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: db.query, $transaction: db.transaction } }));
import { getCompanyKnowledge, searchCompanyKnowledge, saveCompanyKnowledge, KnowledgeConflict } from "../src/ai/assistant/knowledge.js";
let pool: Pool;
const input = { title: "Правило показа", content: "Перед показом согласуйте время с собственником.", source: "Тестовая инструкция" };
beforeAll(async () => {
  const url = new URL(process.env.ASSISTANT_TEST_DATABASE_URL ?? "http://missing");
  if (url.hostname !== "127.0.0.1" || url.port !== "15687" || url.pathname !== "/assistant_knowledge_test") throw new Error("Only isolated assistant test database on 15687 is allowed");
  pool = new Pool({ connectionString: url.href, max: 4 });
  const exists = await pool.query(`SELECT to_regclass('public."AssistantKnowledge"') AS name`);
  if (!exists.rows[0].name) await pool.query(await readFile(new URL("../prisma/migrations/20261103110000_assistant_shared_knowledge/migration.sql", import.meta.url), "utf8"));
  db.query.mockImplementation(async (sql) => (await pool.query(sql.text, sql.values)).rows);
  db.transaction.mockImplementation(async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work({ $queryRaw: async (sql: {text:string;values:unknown[]}) => (await client.query(sql.text, sql.values)).rows,
        $executeRaw: async (sql: {text:string;values:unknown[]}) => (await client.query(sql.text, sql.values)).rowCount });
      await client.query("COMMIT"); return value;
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  });
});
beforeEach(async () => { if (pool) await pool.query('TRUNCATE "AssistantKnowledgeRevision", "AssistantKnowledge"'); });
afterAll(async () => { await pool?.end(); });
it("shared knowledge persists and another connection sees it", async () => {
  await saveCompanyKnowledge(input, "test-agent-a", 0);
  expect((await searchCompanyKnowledge("показ"))[0]).toMatchObject({title:input.title,authorId:"test-agent-a",revision:1});
  const other = new Pool({connectionString:process.env.ASSISTANT_TEST_DATABASE_URL});
  try { expect((await other.query('SELECT count(*)::int AS n FROM "AssistantKnowledge"')).rows[0].n).toBe(1); } finally { await other.end(); }
});
it("updates keep immutable revisions and reject stale writes", async () => {
  await saveCompanyKnowledge(input,"test-agent-a",0);
  await saveCompanyKnowledge({...input,content:"Перед показом уточните время и адрес."},"test-agent-b",1);
  await expect(saveCompanyKnowledge(input,"test-agent-a",1)).rejects.toBeInstanceOf(KnowledgeConflict);
  const rows = await pool.query('SELECT "revision", "authorId" FROM "AssistantKnowledgeRevision" ORDER BY revision');
  expect(rows.rows).toEqual([{revision:1,authorId:"test-agent-a"},{revision:2,authorId:"test-agent-b"}]);
});
it("two simultaneous confirmations cannot overwrite each other", async () => {
  await saveCompanyKnowledge(input,"test-agent",0);
  const results = await Promise.allSettled([saveCompanyKnowledge({...input,content:"Первое изменение правила."},"a",1),saveCompanyKnowledge({...input,content:"Второе изменение правила."},"b",1)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await getCompanyKnowledge(input.title))?.revision).toBe(2);
});
it("two simultaneous inserts of a title create only one record", async () => {
  const results = await Promise.allSettled([saveCompanyKnowledge(input,"a",0),saveCompanyKnowledge(input,"b",0)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
});
it("archived and expired knowledge is absent from answers", async () => {
  await saveCompanyKnowledge(input,"a",0);
  await saveCompanyKnowledge(input,"b",1,true);
  expect(await searchCompanyKnowledge("")).toEqual([]);
  await saveCompanyKnowledge(input,"a",2);
  await pool.query(`UPDATE "AssistantKnowledge" SET "validUntil" = now() - interval '1 day'`);
  expect(await searchCompanyKnowledge("")).toEqual([]);
});
it("search escapes SQL as parameters and limits retrieval", async () => {
  for(let i=0;i<8;i++) await saveCompanyKnowledge({...input,title:`Инструкция ${i}`},"a",0);
  expect(await searchCompanyKnowledge("")).toHaveLength(6);
  await searchCompanyKnowledge("'; DROP TABLE x; --");
  expect((await pool.query('SELECT count(*)::int AS n FROM "AssistantKnowledge"')).rows[0].n).toBe(8);
});
it("ranks relevant titles above newer incidental content matches", async () => {
  await saveCompanyKnowledge({...input,title:"Порядок показа"},"a",0);
  await saveCompanyKnowledge({...input,title:"Порядок уборки",content:"Уборка до показа помещения."},"a",0);
  expect((await searchCompanyKnowledge("показ"))[0].title).toBe("Порядок показа");
});
it("archiving expired knowledge preserves its expiry in revision history", async () => {
  await saveCompanyKnowledge(input,"a",0);
  const expired='2020-01-01T00:00:00.000Z';
  await pool.query('UPDATE "AssistantKnowledge" SET "validUntil" = $1',[expired]);
  const archived=await saveCompanyKnowledge({...input,validUntil:expired},"a",1,true);
  expect(archived.validUntil?.toISOString()).toBe(expired);
  expect(archived.archived).toBe(true);
  const rows=await pool.query('SELECT "validUntil" FROM "AssistantKnowledgeRevision" WHERE "knowledgeId"=$1 AND revision=2',[archived.id]);
  expect(rows.rows[0].validUntil.toISOString()).toBe(expired);
});
