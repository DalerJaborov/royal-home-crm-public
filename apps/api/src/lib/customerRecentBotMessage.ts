import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/** What the dialogue's own message history says about the bot (review 08.11.2026). */
export interface CustomerBotHistory {
  /** A bot message (old bot or core) within the last 12 hours, or a live core reply that is planned/queued/sent but not yet in
   * the history: the reply does not greet again. */
  recentBotMessage: boolean;
  /** Texts of the bot's messages of the last 7 days, oldest first (at most 40). The core memory keeps three exchanges only; this
   * is what keeps a repeated-question loop from starting over (the same district line ten times). */
  botMessages: string[];
}

/**
 * Read from the dialogue's message history, which outlives revision changes and the old-bot migration (the core memory forgets
 * both). A failure is logged and gives `undefined`: the renderer then falls back to its memory rules, never to a guess.
 */
export async function customerBotHistory(conversationId: string, now = new Date()): Promise<CustomerBotHistory | undefined> {
  try {
    const greetSince = new Date(now.getTime() - 12 * 3_600_000), historySince = new Date(now.getTime() - 7 * 24 * 3_600_000);
    const rows = await prisma.$queryRaw<Array<{ recent: boolean; texts: string[] | null }>>`
      WITH m AS (
        SELECT e->>'content' AS content, ord,
          CASE WHEN e->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' THEN (e->>'at')::timestamptz END AS at
        FROM "BotConversation" c,
          jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages") = 'array' THEN c."messages" ELSE '[]'::jsonb END) WITH ORDINALITY AS x(e, ord)
        WHERE c."id" = ${conversationId} AND e->>'role' = 'assistant'
      )
      SELECT (
        EXISTS (SELECT 1 FROM m WHERE m.at > ${greetSince}) OR EXISTS (
          SELECT 1 FROM "CustomerOutboxPart" p WHERE p."conversationId" = ${conversationId} AND p."createdAt" > ${greetSince}
            AND p."mode" = 'LIVE' AND p."status" IN ('READY', 'IN_FLIGHT', 'ACCEPTED', 'UNKNOWN'))
      ) AS "recent",
      (SELECT array_agg(content ORDER BY ord) FROM (
        SELECT content, ord FROM m WHERE m.at > ${historySince} AND content IS NOT NULL ORDER BY ord DESC LIMIT 40) last
      ) AS "texts"
      WHERE EXISTS (SELECT 1 FROM "BotConversation" WHERE "id" = ${conversationId})`;
    const row = rows[0];
    return row ? { recentBotMessage: row.recent === true, botMessages: (row.texts ?? []).filter((text): text is string => typeof text === "string") } : undefined;
  } catch (err) {
    void logSystemError("ai",`История сообщений бота не прочитана — приветствие и память повторов по прежнему правилу: ${describeError(err)}`,
      { dedupKey: "customer-bot-history" });
    return undefined;
  }
}
