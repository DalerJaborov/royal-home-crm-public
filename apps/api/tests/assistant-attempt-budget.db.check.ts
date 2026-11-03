import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: db.query } }));
// Avoid aiDailyBudget's push/recipient imports while using the actual shared day calculation.
vi.mock("../src/lib/aiDailyBudget.js", async () => ({ dushanbeDayKey: (await import("@royal-home/shared")).dushanbeDayKey }));
import { reserveAssistantGeminiAttempt } from "../src/ai/assistant/attemptBudget.js";
let pool: Pool;
beforeAll(async () => {
  const url = new URL(process.env.ASSISTANT_TEST_DATABASE_URL ?? "http://missing");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "15687" || url.pathname !== "/assistant_knowledge_test" || url.username !== "test_assistant") {
    throw new Error("Only isolated assistant test database on 15687 is allowed");
  }
  pool = new Pool({ connectionString: url.href, max: 12 });
  await pool.query(`CREATE TABLE IF NOT EXISTS "AgentAiActionCounter" (
    "id" TEXT PRIMARY KEY, "agentId" TEXT NOT NULL, "action" TEXT NOT NULL, "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, UNIQUE("agentId", "action", "day")
  )`);
  db.query.mockImplementation(async (sql) => (await pool.query(sql.text, sql.values)).rows);
});
beforeEach(async () => {
  if (pool) await pool.query('DELETE FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2', ['assistant-gemini-global', 'assistant-gemini-attempt']);
  db.query.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await pool?.end(); });

it("atomic daily cap permits exactly three of thirty concurrent attempts", async () => {
  vi.stubEnv("ASSISTANT_GEMINI_DAILY_ATTEMPTS", "3");
  const results = await Promise.all(Array.from({ length: 30 }, () => reserveAssistantGeminiAttempt()));
  expect(results.filter(Boolean)).toHaveLength(3);
  const rows = await pool.query('SELECT "count" FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2', ['assistant-gemini-global', 'assistant-gemini-attempt']);
  expect(rows.rows).toEqual([{ count: 3 }]);
});
it.each(["0", "-1", "NaN", "1.5"])("cap %s fails closed before querying the DB", async (limit) => {
  vi.stubEnv("ASSISTANT_GEMINI_DAILY_ATTEMPTS", limit);
  expect(await reserveAssistantGeminiAttempt()).toBe(false);
  expect(db.query).not.toHaveBeenCalled();
});
it("lowering the cap never refunds already reserved attempts", async () => {
  vi.stubEnv("ASSISTANT_GEMINI_DAILY_ATTEMPTS", "3");
  expect(await reserveAssistantGeminiAttempt()).toBe(true);
  expect(await reserveAssistantGeminiAttempt()).toBe(true);
  vi.stubEnv("ASSISTANT_GEMINI_DAILY_ATTEMPTS", "1");
  expect(await reserveAssistantGeminiAttempt()).toBe(false);
  const rows = await pool.query('SELECT "count" FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2', ['assistant-gemini-global', 'assistant-gemini-attempt']);
  expect(rows.rows).toEqual([{ count: 2 }]);
});
