import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { dushanbeDayKey } from "@royal-home/shared";
import { describeError } from "../lib/describeError.js";
/** Shared persistent reservation; no FK on AgentAiActionCounter.agentId. No refund after uncertain provider failure. */
export async function claimAssistantTtsChars(chars: number): Promise<boolean> {
  const configured = Number(process.env.ASSISTANT_TTS_DAILY_CHARS ?? 8000);
  const limit = Number.isSafeInteger(configured) && configured >= 0 ? configured : 8000;
  if (!Number.isSafeInteger(chars) || chars <= 0 || chars > limit)
    return false;
  try {
    const rows = await prisma.$queryRaw<{
      count: number;
    }[]>(Prisma.sql `
   INSERT INTO "AgentAiActionCounter" ("id", "agentId", "action", "day", "count", "createdAt", "updatedAt")
   VALUES (gen_random_uuid()::text, 'assistant-tts-global', 'assistant-tts-chars', ${dushanbeDayKey()}, ${chars}, now(), now())
   ON CONFLICT ("agentId", "action", "day") DO UPDATE
   SET "count" = "AgentAiActionCounter"."count" + EXCLUDED."count", "updatedAt" = now()
   WHERE "AgentAiActionCounter"."count" + EXCLUDED."count" <= ${limit}
   RETURNING "count"
  `);
    return rows.length === 1;
  }
  catch (err) {
    console.warn("[telegram:assistant:voice] бюджет недоступен, только текст:", describeError(err));
    return false;
  }
}
