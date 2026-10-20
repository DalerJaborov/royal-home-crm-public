import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { botTurnTracePayloadSchema, type BotTurnTracePayload } from "@royal-home/shared";
import { createTraceQueue } from "./botTurnTraceQueue.js";
import { isShuttingDown, trackBackgroundTask } from "./shutdownState.js";

let warned = false;
function alarm() { if (!warned) { warned = true; console.warn("[bot-trace] diagnostic checkpoint dropped"); } }
export async function writeBotTurnTrace(payload: BotTurnTracePayload): Promise<void> {
  // Conditional sequence prevents late async checkpoints overwriting final state.
  const json = JSON.stringify(botTurnTracePayloadSchema.parse(payload));
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "BotTurnTrace" ("id", "schemaVersion", "coverage", "createdAt", "updatedAt", "completedAt", "expiresAt", "checkpointSeq", "outcome", "channel", "source", "eventKey", "conversationKey", "accountKey", "payload")
    VALUES (${payload.traceId}, 1, ${payload.coverage}, ${new Date(payload.createdAt)}, NOW(), ${payload.completedAt ? new Date(payload.completedAt) : null}, ${new Date(payload.expiresAt)}, ${payload.checkpointSeq}, ${payload.outcome}, ${payload.channel}, ${payload.source}, ${payload.eventKey}, ${payload.conversationKey}, ${payload.accountKey}, ${json}::jsonb)
    ON CONFLICT ("id") DO UPDATE SET "updatedAt" = NOW(), "completedAt" = EXCLUDED."completedAt", "checkpointSeq" = EXCLUDED."checkpointSeq", "outcome" = EXCLUDED."outcome", "conversationKey" = EXCLUDED."conversationKey", "accountKey" = EXCLUDED."accountKey", "payload" = EXCLUDED."payload"
    WHERE "BotTurnTrace"."checkpointSeq" < EXCLUDED."checkpointSeq" AND "BotTurnTrace"."completedAt" IS NULL`);
}
const writer = createTraceQueue(writeBotTurnTrace, alarm, 64, 4, (task) => { trackBackgroundTask(task).catch(alarm); });
export function enqueueBotTurnTrace(payload: BotTurnTracePayload): void {
  if (isShuttingDown()) { alarm(); return; }
  writer.enqueue(payload);
}
export async function cleanupBotTurnTraces(now = new Date()): Promise<number> {
  const result = await prisma.botTurnTrace.deleteMany({ where: { expiresAt: { lte: now } } });
  return result.count;
}
