import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { dushanbeDayKey } from "@royal-home/shared";
/**
 * Дневной потолок озвучки Шабнам в знаках, если ASSISTANT_TTS_DAILY_CHARS не задана (переменная важнее).
 * 22.11.2026, владелец: «увеличь его на максимум» — было 8000. Не бесконечно: защита от цикла, который за ночь сожжёт баланс ElevenLabs.
 */
export const ASSISTANT_TTS_DAILY_CHARS_DEFAULT = 200_000;

/** Shared persistent reservation; no FK on AgentAiActionCounter.agentId. No refund after uncertain provider failure. */
export async function claimAssistantTtsChars(chars: number): Promise<boolean> {
  const limit = Number(process.env.ASSISTANT_TTS_DAILY_CHARS ?? ASSISTANT_TTS_DAILY_CHARS_DEFAULT);
  if (!Number.isInteger(limit) || limit < 0 || limit > 2_147_483_647)
    return false;
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
  catch {
    console.warn("[telegram:assistant:voice] voice failed", { stage: "budget" });
    return false;
  }
}
