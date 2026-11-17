import { randomUUID } from "node:crypto";
import {
  customerPropertyFocusSchema,
  type CustomerPropertyAdmission,
  type CustomerPropertyFocus,
  type CustomerPropertyResolution,
} from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { customerPropertyScopeKey } from "./customerPropertyScope.js";

/** Called inside the early admission transaction; no async enrichment precedes it. */
export async function reserveCustomerPropertyFocus(tx: TxClient, ticket: CustomerPropertyAdmission): Promise<void> {
  if (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) return;
  const pending = customerPropertyFocusSchema.parse({
    version: 1, scopeKey: ticket.scopeKey, generation: randomUUID(),
    lastEvidenceOrder: ticket.order, eventKey: ticket.eventKey,
    status: ticket.evidence.length ? "pending" : "missing", propertyId: null, evidence: ticket.evidence,
  });
  await tx.$executeRaw(Prisma.sql`
    UPDATE "BotConversation"
    SET "customerPropertyFocus" = ${JSON.stringify(pending)}::jsonb,
        "customerPropertyFocusRevision" = "customerPropertyFocusRevision" + 1
    WHERE "id" = ${ticket.conversationId}
      AND "channel" = ${ticket.channel}
      AND "accountId" IS NOT DISTINCT FROM ${ticket.accountId}
      AND (${ticket.endpointScopeId ?? null}::text IS NULL OR "endpointScopeId" = ${ticket.endpointScopeId ?? null})
      AND (
        "customerPropertyFocus" IS NULL OR
        (${ticket.evidence.length > 0} AND CASE WHEN "customerPropertyFocus"->>'lastEvidenceOrder' ~ '^[1-9][0-9]{0,18}$'
          THEN ("customerPropertyFocus"->>'lastEvidenceOrder')::numeric < ${ticket.order}::numeric
          ELSE FALSE END)
      )`);
}

/** In-turn retry counts as one: a failed read is re-read on ONE later turn, then reported to the customer. */
export const CUSTOMER_PROPERTY_LOOKUP_MAX_ATTEMPTS = 2;
export interface CustomerPropertyFocusSnapshot { focus: CustomerPropertyFocus; revision: number }
function ownsPending(ticket: CustomerPropertyAdmission, snapshot: CustomerPropertyFocusSnapshot): boolean {
  return snapshot.focus.status === "pending" && snapshot.focus.scopeKey === ticket.scopeKey &&
    snapshot.focus.eventKey === ticket.eventKey && snapshot.focus.lastEvidenceOrder === ticket.order;
}
export async function readCustomerPropertyFocus(ticket: CustomerPropertyAdmission): Promise<CustomerPropertyFocusSnapshot | null> {
  const row = await prisma.botConversation.findUnique({
    where: { id: ticket.conversationId },
    select: { channel: true, subscriberId: true, accountId: true, endpointScopeId: true, customerPropertyFocus: true, customerPropertyFocusRevision: true },
  });
  if (!row || row.channel !== ticket.channel || row.accountId !== ticket.accountId ||
      (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) ||
      (ticket.endpointScopeId && row.endpointScopeId !== ticket.endpointScopeId) ||
      customerPropertyScopeKey(row.channel, row.subscriberId, row.accountId, ticket.endpointScopeId) !== ticket.scopeKey) return null;
  const parsed = customerPropertyFocusSchema.safeParse(row.customerPropertyFocus);
  if (!parsed.success || parsed.data.scopeKey !== ticket.scopeKey) return null;
  return { focus: parsed.data, revision: row.customerPropertyFocusRevision };
}

/** Completion cannot adopt a newer generation/revision and overwrite its object. */
export async function completeCustomerPropertyFocus(
  ticket: CustomerPropertyAdmission,
  snapshot: CustomerPropertyFocusSnapshot,
  resolution: CustomerPropertyResolution,
): Promise<boolean> {
  if (!ownsPending(ticket, snapshot)) return false;
  if (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) return false;
  const { lookupAttempts: previousAttempts, ...rest } = snapshot.focus;
  const next = customerPropertyFocusSchema.parse({
    ...rest, status: resolution.status, propertyId: resolution.propertyId,
    // A transient read failure is remembered so the next turn can retry; any other answer clears it.
    ...(resolution.reason === "lookup_unavailable" ? { lookupAttempts: Math.min((previousAttempts ?? 0) + 1, CUSTOMER_PROPERTY_LOOKUP_MAX_ATTEMPTS) } : {}),
  });
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE "BotConversation"
    SET "customerPropertyFocus" = ${JSON.stringify(next)}::jsonb
    WHERE "id" = ${ticket.conversationId}
      AND "channel" = ${ticket.channel}
      AND "accountId" IS NOT DISTINCT FROM ${ticket.accountId}
      AND (${ticket.endpointScopeId ?? null}::text IS NULL OR "endpointScopeId" = ${ticket.endpointScopeId ?? null})
      AND "customerPropertyFocusRevision" = ${snapshot.revision}
      AND "customerPropertyFocus"->>'scopeKey' = ${ticket.scopeKey}
      AND "customerPropertyFocus"->>'eventKey' = ${ticket.eventKey}
      AND "customerPropertyFocus"->>'lastEvidenceOrder' = ${ticket.order}
      AND "customerPropertyFocus"->>'generation' = ${snapshot.focus.generation}
      AND "customerPropertyFocus"->>'status' = 'pending'`);
  return changed > 0;
}

/** Persist the captured debounce batch before lookup; retries retain conflicts. */
export async function persistCustomerPropertyBatchEvidence(
  ticket: CustomerPropertyAdmission,
  snapshot: CustomerPropertyFocusSnapshot,
  evidence: CustomerPropertyFocus["evidence"],
): Promise<CustomerPropertyFocusSnapshot | null> {
  if (!ownsPending(ticket, snapshot)) return null;
  if (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) return null;
  const next = customerPropertyFocusSchema.parse({ ...snapshot.focus, evidence });
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE "BotConversation" SET "customerPropertyFocus" = ${JSON.stringify(next)}::jsonb,
      "customerPropertyFocusRevision" = "customerPropertyFocusRevision" + 1
    WHERE "id" = ${ticket.conversationId} AND "channel" = ${ticket.channel}
      AND "accountId" IS NOT DISTINCT FROM ${ticket.accountId}
      AND (${ticket.endpointScopeId ?? null}::text IS NULL OR "endpointScopeId" = ${ticket.endpointScopeId ?? null})
      AND "customerPropertyFocusRevision" = ${snapshot.revision}
      AND "customerPropertyFocus"->>'scopeKey' = ${ticket.scopeKey}
      AND "customerPropertyFocus"->>'generation' = ${snapshot.focus.generation}
      AND "customerPropertyFocus"->>'eventKey' = ${ticket.eventKey}
      AND "customerPropertyFocus"->>'lastEvidenceOrder' = ${ticket.order}
      AND "customerPropertyFocus"->>'status' = 'pending'`);
  return changed > 0 ? { focus: next, revision: snapshot.revision + 1 } : null;
}

export function customerPropertyLookupRetryDue(focus: CustomerPropertyFocus): boolean {
  return focus.status === "missing" && focus.evidence.length > 0 && focus.lookupAttempts !== undefined &&
    focus.lookupAttempts < CUSTOMER_PROPERTY_LOOKUP_MAX_ATTEMPTS;
}
/** The focus owner stays the original evidence event (same eventKey/order); only the generation changes, so
 * the ordinary pending branch re-resolves it. Compare-and-set on revision: a concurrent turn wins, never both. */
export async function reopenCustomerPropertyFocusForRetry(
  ticket: CustomerPropertyAdmission,
  snapshot: CustomerPropertyFocusSnapshot,
): Promise<CustomerPropertyFocusSnapshot | null> {
  if (!customerPropertyLookupRetryDue(snapshot.focus)) return null;
  if (ticket.accountId === null && ticket.channel !== "WEBSITE" && !ticket.endpointScopeId) return null;
  const next = customerPropertyFocusSchema.parse({ ...snapshot.focus, status: "pending", propertyId: null, generation: randomUUID() });
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE "BotConversation" SET "customerPropertyFocus" = ${JSON.stringify(next)}::jsonb,
      "customerPropertyFocusRevision" = "customerPropertyFocusRevision" + 1
    WHERE "id" = ${ticket.conversationId} AND "channel" = ${ticket.channel}
      AND "accountId" IS NOT DISTINCT FROM ${ticket.accountId}
      AND (${ticket.endpointScopeId ?? null}::text IS NULL OR "endpointScopeId" = ${ticket.endpointScopeId ?? null})
      AND "customerPropertyFocusRevision" = ${snapshot.revision}
      AND "customerPropertyFocus"->>'scopeKey' = ${ticket.scopeKey}
      AND "customerPropertyFocus"->>'generation' = ${snapshot.focus.generation}
      AND "customerPropertyFocus"->>'status' = 'missing'`);
  return changed > 0 ? { focus: next, revision: snapshot.revision + 1 } : null;
}
