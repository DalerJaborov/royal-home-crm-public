import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ prisma: { $queryRaw: db.query } }));
// Avoid aiDailyBudget's push/recipient imports while using the actual shared day calculation.
vi.mock("../src/lib/aiDailyBudget.js", async () => ({ dushanbeDayKey: (await import("@royal-home/shared")).dushanbeDayKey }));
import { createAssistantMoneyWallet } from "../src/ai/assistant/moneyBudget.js";
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
  if (pool) await pool.query('DELETE FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2', ['assistant-gemini-global', 'assistant-gemini-reserved-microusd']);
  db.query.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await pool?.end(); });

it("atomic dollar reservation permits exactly three of thirty independent wallets", async () => {
  const results = await Promise.allSettled(Array.from({ length: 30 }, () =>
    createAssistantMoneyWallet({ dailyUsd: "0.000003", turnUsd: "0.000003" }).reserve(1)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(3);
  const rows = await pool.query('SELECT "count" FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2',
    ['assistant-gemini-global', 'assistant-gemini-reserved-microusd']);
  expect(rows.rows).toEqual([{ count: 3 }]);
});
it("a lowered daily limit cannot admit new reservations or refund existing holds", async () => {
  await createAssistantMoneyWallet({ dailyUsd: "0.000005", turnUsd: "0.000005" }).reserve(4);
  await expect(createAssistantMoneyWallet({ dailyUsd: "0.000003", turnUsd: "0.000003" }).reserve(1)).rejects.toMatchObject({ code: "assistant_attempt_limit" });
  const rows = await pool.query('SELECT "count" FROM "AgentAiActionCounter" WHERE "agentId"=$1 AND "action"=$2',
    ['assistant-gemini-global', 'assistant-gemini-reserved-microusd']);
  expect(rows.rows).toEqual([{ count: 4 }]);
});
it("database failure stops generation allowance", async () => {
  db.query.mockRejectedValueOnce(new Error("test database unavailable"));
  await expect(createAssistantMoneyWallet().reserve(100)).rejects.toMatchObject({ code: "assistant_attempt_limit" });
});
