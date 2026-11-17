import { prisma } from "../db.js";
import { customerSpamMuteFrom, customerSpamMuteRecord, type CustomerSpamMute } from "../ai/customerSpamMute.js";

/**
 * Where the spam mark lives: `BotConversation.leadDraft.spamMute`. No migration was possible for this batch, and `leadDraft`
 * is already a free-form per-dialogue JSON object that the legacy engine only merges `stage` into. Written ONLY by a single
 * jsonb_set/jsonb-minus statement, so a concurrent legacy `stage` write cannot be lost and this one cannot lose the draft.
 * A dedicated nullable column would be cleaner; see the batch journal.
 */
const KEY = "spamMute";

export async function readCustomerSpamMute(conversationId: string): Promise<CustomerSpamMute> {
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { leadDraft: true } });
  const draft = row?.leadDraft;
  return customerSpamMuteFrom(draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>)[KEY] : undefined);
}

async function write(conversationId: string, state: CustomerSpamMute): Promise<void> {
  const json = JSON.stringify(state);
  await prisma.$executeRaw`UPDATE "BotConversation" SET "leadDraft" = CASE
      WHEN jsonb_typeof("leadDraft") = 'object' THEN jsonb_set("leadDraft", ARRAY[${KEY}]::text[], ${json}::jsonb, true)
      ELSE jsonb_build_object(${KEY}::text, ${json}::jsonb) END
    WHERE "id" = ${conversationId}`;
}

/** Count one spam turn (idempotent per event key) and set the mark at the threshold. Returns the new state. */
export async function recordCustomerSpamTurn(conversationId: string, turn: { eventKey: string; now?: Date }): Promise<CustomerSpamMute> {
  const next = customerSpamMuteRecord(await readCustomerSpamMute(conversationId), { key: turn.eventKey.slice(0, 32), now: turn.now ?? new Date() });
  await write(conversationId, next);
  return next;
}

/** A real request ended the mute: forget the whole mark. */
export async function clearCustomerSpamMute(conversationId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "BotConversation" SET "leadDraft" = "leadDraft" - ${KEY}::text
    WHERE "id" = ${conversationId} AND jsonb_typeof("leadDraft") = 'object' AND jsonb_exists("leadDraft", ${KEY}::text)`;
}
