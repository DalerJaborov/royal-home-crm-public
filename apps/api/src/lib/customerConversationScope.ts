import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { readInstalledCustomerTransport } from "./customerInstalledTransport.js";

const CHANNELS = new Set(["INSTAGRAM", "FACEBOOK", "WHATSAPP", "WEBSITE"]);
const REALM = "royal-home";
export interface CustomerTransportEndpoint {
  channel: string; subscriberId: string; accountId?: string | null; accountExternalId?: string;
  transport?: CustomerTransportReference;
}
export interface CustomerTransportReference {
  endpointScopeId: string; channel: string; accountId: string | null; accountExternalId?: string;
  transportKey: string; scopeRevision: string;
}
export interface ScopedCustomerEndpoint extends CustomerTransportReference { subscriberId: string }
export type CustomerTransportHint = CustomerTransportReference | string | null;
/** Server-owned compatibility hint. A legacy UUID selects that exact installed
 * account only; null/undefined never chooses a current Meta default. */
export function customerTransportInput(channel: string, subscriberId: string, hint?: CustomerTransportHint): CustomerTransportEndpoint {
  return { channel, subscriberId, ...(typeof hint === "object" && hint ? { transport: hint } : { accountId: hint }) };
}
export class CustomerScopeDenied extends Error {
  constructor(readonly reason: "account_unknown" | "account_mismatch" | "scope_unknown" | "compat_collision") {
    super(`Customer endpoint denied: ${reason}`);
  }
}
type ScopeDb = Pick<TxClient, "messengerAccount" | "$queryRaw" | "$executeRaw">;
/** Exact configured transport selection, without provider reconciliation/default
 * accounts/contact recognition. This is routing, never identity/private proof. */
async function accountForEndpoint(db: ScopeDb, input: CustomerTransportEndpoint): Promise<{ accountId: string | null; transportKey: string }> {
  if (!CHANNELS.has(input.channel) || !input.subscriberId || input.subscriberId.length > 512) throw new CustomerScopeDenied("scope_unknown");
  if (input.channel === "WEBSITE") {
    if (input.accountId || input.accountExternalId) throw new CustomerScopeDenied("account_mismatch");
    return { accountId: null, transportKey: "website-public-chat" };
  }
  if (!input.accountId && !input.accountExternalId) throw new CustomerScopeDenied("account_unknown");
  const externalId = input.accountExternalId;
  const rows = await db.messengerAccount.findMany({ where: {
    channel: input.channel, ...(input.accountId ? { id: input.accountId } : { OR: [
      { externalId }, { messagingId: externalId }, { extraExternalIds: { has: externalId ?? "__no_account__" } },
    ] }),
  }, select: { id: true, externalId: true, messagingId: true, extraExternalIds: true }, take: 2 });
  if (!rows.length && !input.accountId) {
    const installed = await readInstalledCustomerTransport(db, input.channel, externalId);
    if (installed) return { accountId: null, transportKey: installed.transportKey };
  }
  if (rows.length !== 1) throw new CustomerScopeDenied("account_unknown");
  const row = rows[0];
  if (externalId && await readInstalledCustomerTransport(db, input.channel, externalId)) throw new CustomerScopeDenied("account_mismatch");
  if (input.accountExternalId && ![row.externalId, row.messagingId, ...row.extraExternalIds].includes(input.accountExternalId)) {
    throw new CustomerScopeDenied("account_mismatch");
  }
  return { accountId: row.id, transportKey: `messenger-account:${row.id}` };
}
/** Looking up a scope does not create/heal it. Current application-owned website
 * installation is one public scope; an arbitrary session ID has no private ACL. */
export async function resolveCustomerEndpoint(input: CustomerTransportEndpoint, db: ScopeDb = prisma): Promise<ScopedCustomerEndpoint> {
  const selected = await accountForEndpoint(db, { ...input, accountId: input.transport?.accountId ?? input.accountId,
    accountExternalId: input.transport?.accountExternalId ?? input.accountExternalId });
  const { accountId, transportKey } = selected;
  const rows = await db.$queryRaw<{ id: string; messengerAccountId: string | null; kind: string; scopeRevision: bigint }[]>`
    SELECT "id", "messengerAccountId", "kind", "scopeRevision" FROM "CustomerEndpointScope"
    WHERE "realmKey" = ${REALM} AND "channel" = ${input.channel} AND "transportKey" = ${transportKey}`;
  if (rows.length !== 1 || rows[0].kind !== "NORMAL" || rows[0].messengerAccountId !== accountId) throw new CustomerScopeDenied("scope_unknown");
  if (input.transport && (input.transport.channel !== input.channel || input.transport.accountId !== accountId ||
      input.transport.endpointScopeId !== rows[0].id || input.transport.transportKey !== transportKey ||
      input.transport.scopeRevision !== rows[0].scopeRevision.toString())) throw new CustomerScopeDenied("account_mismatch");
  return { endpointScopeId: rows[0].id, channel: input.channel, subscriberId: input.subscriberId, accountId, transportKey,
    accountExternalId: input.transport?.accountExternalId ?? input.accountExternalId, scopeRevision: rows[0].scopeRevision.toString() };
}
/** Early authenticated adapter / staff send creation transaction. No native
 * account overwrite and no fallback to a global row on scoped conflict. */
export async function ensureCustomerEndpoint(db: ScopeDb, input: CustomerTransportEndpoint): Promise<ScopedCustomerEndpoint> {
  if (input.transport) return resolveCustomerEndpoint(input, db);
  const { accountId, transportKey } = await accountForEndpoint(db, input);
  await db.$executeRaw`
    INSERT INTO "CustomerEndpointScope" ("id", "realmKey", "channel", "transportKey", "kind", "messengerAccountId", "updatedAt")
    VALUES (${randomUUID()}, ${REALM}, ${input.channel}, ${transportKey}, 'NORMAL', ${accountId}, now())
    ON CONFLICT ("realmKey", "channel", "transportKey") DO NOTHING`;
  return resolveCustomerEndpoint(input, db);
}
export async function findScopedBotConversation(input: CustomerTransportEndpoint, db: ScopeDb = prisma): Promise<{ id: string; accountId: string | null } | null> {
  const endpoint = await resolveCustomerEndpoint(input, db);
  const rows = await db.$queryRaw<{ id: string; accountId: string | null }[]>`
    SELECT "id", "accountId" FROM "BotConversation" WHERE "endpointScopeId" = ${endpoint.endpointScopeId}
      AND "channel" = ${endpoint.channel} AND "subscriberId" = ${endpoint.subscriberId}
      AND "accountId" IS NOT DISTINCT FROM ${endpoint.accountId}`;
  return rows.length === 1 ? rows[0] : null;
}
/** Trusted resource-ID routing for retries/staff dispatch. It reads the stored
 * namespace and then revalidates current installation; never maps NULL account
 * to today's default or authorizes private customer state. */
export async function loadCustomerTransportForConversation(conversationId: string, db: ScopeDb = prisma): Promise<CustomerTransportReference | null> {
  const rows = await db.$queryRaw<Array<{ channel: string; subscriberId: string; accountId: string | null; endpointScopeId: string;
    transportKey: string; scopeRevision: bigint; externalId: string | null }>>`
    SELECT c."channel", c."subscriberId", c."accountId", s."id" AS "endpointScopeId", s."transportKey", s."scopeRevision", a."externalId"
    FROM "BotConversation" c JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId" AND s."kind"='NORMAL'
    LEFT JOIN "MessengerAccount" a ON a."id"=c."accountId"
    WHERE c."id"=${conversationId} AND s."channel"=c."channel" AND s."messengerAccountId" IS NOT DISTINCT FROM c."accountId"`;
  if (rows.length !== 1) return null;
  const row = rows[0];
  const installationPrefix = `settings:${row.channel}:`;
  const accountExternalId = row.externalId ?? (row.transportKey.startsWith(installationPrefix) ? row.transportKey.slice(installationPrefix.length) : undefined);
  const transport: CustomerTransportReference = { channel: row.channel, accountId: row.accountId, endpointScopeId: row.endpointScopeId,
    transportKey: row.transportKey, scopeRevision: row.scopeRevision.toString(), accountExternalId };
  try { return await resolveCustomerEndpoint({ channel: row.channel, subscriberId: row.subscriberId, transport }, db); }
  catch (error) { if (error instanceof CustomerScopeDenied) return null; throw error; }
}
/** Gate A retains old indexes. A different account with the same raw peer is
 * explicitly held until the independently verified contract-cutover release. */
export async function ensureScopedBotConversation(db: ScopeDb, input: CustomerTransportEndpoint): Promise<{ id: string; accountId: string | null; transport: CustomerTransportReference }> {
  const endpoint = await ensureCustomerEndpoint(db, input);
  const [policy] = await db.$queryRaw<{ contractVersion: string }[]>`
    SELECT "contractVersion" FROM "CustomerRuntimePolicy" WHERE "id" = 'singleton'`;
  if (!policy || policy.contractVersion !== "scoped") {
    const collision = await db.$queryRaw<{ conflict: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "BotConversation" WHERE "channel" = ${endpoint.channel} AND "subscriberId" = ${endpoint.subscriberId}
        AND ("endpointScopeId" IS DISTINCT FROM ${endpoint.endpointScopeId} OR "accountId" IS DISTINCT FROM ${endpoint.accountId})) AS "conflict"`;
    if (collision[0]?.conflict) throw new CustomerScopeDenied("compat_collision");
  }
  // Gate A retains both scoped and global unique indexes. Concurrent speculative
  // inserts can collide with either; arbitrate both without aborting the caller's
  // transaction. The exact scoped read below still rejects another installation:
  // no global-row fallback, index removal or account overwrite is permitted.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "BotConversation" ("id", "endpointScopeId", "channel", "subscriberId", "accountId", "messages", "leadDraft", "updatedAt")
    VALUES (${randomUUID()}, ${endpoint.endpointScopeId}, ${endpoint.channel}, ${endpoint.subscriberId}, ${endpoint.accountId},
      '[]'::jsonb, '{"stage":"chatting"}'::jsonb, now())
    ON CONFLICT DO NOTHING`);
  const row = await findScopedBotConversation(input, db);
  if (!row) throw new CustomerScopeDenied("account_mismatch");
  await db.$executeRaw`
    INSERT INTO "CustomerInquiry" ("id", "endpointScopeId", "peerId", "threadId", "conversationId", "ownerMode", "ownerAgentId", "ownerToken", "legacyMemoryQuarantined", "updatedAt")
    SELECT ${randomUUID()}, ${endpoint.endpointScopeId}, ${endpoint.subscriberId}, '', "id",
      'HOLD', NULL, NULL, TRUE, now() FROM "BotConversation" WHERE "id" = ${row.id}
    ON CONFLICT ("endpointScopeId", "peerId", "threadId") DO NOTHING`;
  return { ...row, transport: endpoint };
}
