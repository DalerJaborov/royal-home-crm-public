import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { dushanbeDayKey } from "../../lib/aiDailyBudget.js";

/** Global call cap, NOT a monetary budget. Includes retries and grounded search. */
export async function reserveAssistantGeminiAttempt(): Promise<boolean> {
  const limit = Number(process.env.ASSISTANT_GEMINI_DAILY_ATTEMPTS ?? "300");
  if (!Number.isSafeInteger(limit) || limit <= 0) return false;
  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO "AgentAiActionCounter" ("id", "agentId", "action", "day", "count", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, 'assistant-gemini-global', 'assistant-gemini-attempt', ${dushanbeDayKey()}, 1, now(), now())
    ON CONFLICT ("agentId", "action", "day") DO UPDATE
    SET "count" = "AgentAiActionCounter"."count" + 1, "updatedAt" = now()
    WHERE "AgentAiActionCounter"."count" < ${limit}
    RETURNING "count"
  `);
  return rows.length === 1;
}
