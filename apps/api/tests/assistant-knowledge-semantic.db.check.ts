import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), transaction: vi.fn(), embed: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute, $transaction: mocks.transaction } }));
vi.mock("../src/ai/embeddings.js", () => ({ embedText: mocks.embed,
  cosineSimilarity: (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b)) }));
vi.mock("../src/ai/geminiTransport.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/geminiTransport.js")>(), GEMINI_EMBEDDING_MODEL: "gemini-embedding-001", GEMINI_EMBEDDING_DIMENSIONS: 2,
}));
import { indexCompanyKnowledge, pendingKnowledgeIndex, semanticKnowledgeSearch } from "../src/ai/assistant/knowledgeSemantic.js";
import { saveCompanyKnowledge, searchCompanyKnowledge } from "../src/ai/assistant/knowledge.js";
let pool: Pool;
const input = { title: "Порядок показа", content: "Согласуйте время до выезда.", source: "Тестовая инструкция" };
const options = () => ({ beforeAttempt: vi.fn(async () => {}) });
beforeAll(async () => {
  const url = new URL(process.env.ASSISTANT_TEST_DATABASE_URL ?? "http://missing");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "15687" || url.pathname !== "/assistant_knowledge_test" || url.username !== "test_assistant") {
    throw new Error("Only isolated assistant test database on 15687 is allowed");
  }
  pool = new Pool({ connectionString: url.href, max: 4 });
  for (const [table, migration] of [
    ['AssistantKnowledge', '20261103110000_assistant_shared_knowledge'],
    ['AssistantKnowledgeEmbedding', '20261103160000_assistant_knowledge_embeddings'],
  ]) {
    const exists = await pool.query('SELECT to_regclass($1) AS name', [`public."${table}"`]);
    if (!exists.rows[0].name) await pool.query(await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8"));
  }
  mocks.query.mockImplementation(async (sql) => (await pool.query(sql.text, sql.values)).rows);
  mocks.execute.mockImplementation(async (sql) => (await pool.query(sql.text, sql.values)).rowCount);
  mocks.transaction.mockImplementation(async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work({ $queryRaw: async (sql: { text: string; values: unknown[] }) => (await client.query(sql.text, sql.values)).rows,
        $executeRaw: async (sql: { text: string; values: unknown[] }) => (await client.query(sql.text, sql.values)).rowCount });
      await client.query("COMMIT"); return result;
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  });
});
beforeEach(async () => {
  vi.stubEnv("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "true");
  if (pool) await pool.query('TRUNCATE "AssistantKnowledgeEmbedding", "AssistantKnowledgeRevision", "AssistantKnowledge"');
  mocks.embed.mockReset().mockResolvedValue([1, 0]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => { await pool?.end(); });
it("indexes a valid vector and finds a fact without keyword overlap", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  expect(await indexCompanyKnowledge([{ id: row.id, revision: row.revision }], options())).toEqual({ indexed: 1, skipped: 0 });
  expect(await pendingKnowledgeIndex()).toEqual([]);
  expect((await semanticKnowledgeSearch("совсем другое выражение", options()))[0].id).toBe(row.id);
  const stored = await pool.query('SELECT "revision", "model", "dimensions", "embedding" FROM "AssistantKnowledgeEmbedding"');
  expect(stored.rows).toEqual([{ revision: 1, model: "gemini-embedding-001", dimensions: 2, embedding: [1, 0] }]);
});
it("does not store a stale vector after an edit during embedding", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  mocks.embed.mockImplementationOnce(async () => { await saveCompanyKnowledge({ ...input, content: "Сначала уточните новый адрес." }, "test-agent", 1); return [1, 0]; });
  expect(await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).toEqual({ indexed: 0, skipped: 1 });
  expect((await pool.query('SELECT count(*)::int AS count FROM "AssistantKnowledgeEmbedding"')).rows[0].count).toBe(0);
  expect((await pendingKnowledgeIndex())[0].revision).toBe(2);
});
it("excludes archived knowledge even if archive happens during query embedding", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options());
  mocks.embed.mockImplementationOnce(async () => { await saveCompanyKnowledge(input, "test-agent", 1, true); return [1, 0]; });
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
});
it("rejects invalid vectors without inserting an index row", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  mocks.embed.mockResolvedValue([NaN, 0]);
  await expect(indexCompanyKnowledge([{ id: row.id, revision: 1 }], options())).rejects.toThrow("вектор");
  expect((await pool.query('SELECT count(*)::int AS count FROM "AssistantKnowledgeEmbedding"')).rows[0].count).toBe(0);
});
it("keyword fallback refreshes facts after a failed embedding", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options());
  mocks.embed.mockImplementationOnce(async () => { await saveCompanyKnowledge({ ...input, content: "Новая инструкция по показу." }, "test-agent", 1); throw new Error("Google unavailable"); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const results = await searchCompanyKnowledge("показ", options());
  expect(results[0].revision).toBe(2); expect(results[0].content).toBe("Новая инструкция по показу.");
});
it("old revision, wrong model and expired records are excluded without a query embedding", async () => {
  const row = await saveCompanyKnowledge(input, "test-agent", 0);
  await indexCompanyKnowledge([{ id: row.id, revision: 1 }], options());
  await saveCompanyKnowledge({ ...input, content: "Новая инструкция по показу." }, "test-agent", 1);
  mocks.embed.mockClear();
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
  await indexCompanyKnowledge([{ id: row.id, revision: 2 }], options());
  await pool.query('UPDATE "AssistantKnowledgeEmbedding" SET "model"=$1', ['test-other-model']);
  mocks.embed.mockClear();
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
  await pool.query('UPDATE "AssistantKnowledgeEmbedding" SET "model"=$1', ['gemini-embedding-001']);
  await pool.query('UPDATE "AssistantKnowledge" SET "validUntil"=now()-interval \'1 minute\'');
  expect(await semanticKnowledgeSearch("показ", options())).toEqual([]);
  expect(mocks.embed).not.toHaveBeenCalled();
});
