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
/**
 * ОДНА ПЕРЕПИСКА WHATSAPP НА КАЖДЫЙ НАШ НОМЕР (владелец 26.11.2026: «один бот, одно ядро
 * отвечает всем везде»; второй номер — Arvan). В WhatsApp собеседник — это номер
 * телефона, поэтому человек, уже писавший на Royal Home, пишет на Arvan тем же
 * subscriberId. Переписка — пара (область нашего номера, номер собеседника): бот
 * отвечает в каждой с её номера и от её бренда.
 *
 * Рубильник `WHATSAPP_CHAT_PER_NUMBER=off` возвращает прежнее (#475): одна переписка
 * на человека, ход на другой номер удерживается для сотрудника и ложится в старую
 * переписку. Уже раздельные переписки при этом продолжают жить: рубильник запрещает
 * только заводить новую вторую.
 */
export function whatsappChatPerNumber(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WHATSAPP_CHAT_PER_NUMBER?.trim().toLowerCase() !== "off";
}
export type PeerChatRow = { endpointScopeId: string | null; scopeKind: string | null };
/**
 * Единственное правило «какие переписки этого собеседника мешают переписке в области
 * `endpointScopeId`» — для решения ядра (customerAgentEnrollment), перевода на ядро
 * (customerAgentLegacyCutover) и создания строки (ensureScopedBotConversation ниже).
 * - own: переписка в этой же области (их не больше одной: уникальный ключ области).
 * - blocking: чужие переписки, рядом с которыми новую заводить нельзя. В WhatsApp
 *   переписка на ДРУГОМ нашем номере (область NORMAL) не мешает; старая переписка без
 *   номера (LEGACY_UNKNOWN) мешает, как раньше: её нельзя раздвоить догадкой.
 *   Instagram/Facebook — любая чужая мешает (у них идентификатор свой на аккаунт).
 * - otherNumberHold: рубильник выключен, и человек пишет на второй номер, имея одну
 *   переписку на первом, — поведение #475 (удержать для сотрудника).
 */
export function peerChatsForScope<T extends PeerChatRow>(channel: string, rows: readonly T[], endpointScopeId: string,
  perNumber: boolean = whatsappChatPerNumber()): { own: T[]; blocking: T[]; otherNumberHold: boolean } {
  const own = rows.filter(row => row.endpointScopeId === endpointScopeId);
  const others = rows.filter(row => row.endpointScopeId !== endpointScopeId);
  const otherNumbers = channel === "WHATSAPP" && others.length > 0 && others.every(row => !!row.endpointScopeId && row.scopeKind === "NORMAL");
  if (otherNumbers && (perNumber || own.length > 0)) return { own, blocking: [], otherNumberHold: false };
  return { own, blocking: others, otherNumberHold: otherNumbers && own.length === 0 && others.length === 1 };
}
/** Переписки этого собеседника в канале с видом области — вход для peerChatsForScope. */
export async function readPeerChats(db: Pick<TxClient, "$queryRaw">, channel: string, peer: string):
  Promise<Array<{ id: string; endpointScopeId: string | null; accountId: string | null; scopeKind: string | null; clientId: string | null }>> {
  return db.$queryRaw`SELECT c."id", c."endpointScopeId", c."accountId", s."kind" AS "scopeKind", c."clientId"
    FROM "BotConversation" c LEFT JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId"
    WHERE c."channel"=${channel} AND c."subscriberId"=${peer} ORDER BY c."createdAt", c."id" LIMIT 20`;
}
/** Карточка клиента для НОВОЙ переписки WhatsApp: номер собеседника — подтверждённый
 * транспортом признак человека, поэтому вторая переписка того же номера сразу
 * привязана к той же карточке. Только если у всех его переписок ровно одна живая
 * карточка; разные карточки — не выбираем (их разбирает человек). */
async function siblingWhatsappClient(db: Pick<TxClient, "$queryRaw">, rows: ReadonlyArray<{ clientId: string | null }>): Promise<string | null> {
  const ids = [...new Set(rows.map(row => row.clientId).filter((id): id is string => !!id))];
  if (ids.length !== 1) return null;
  const [live] = await db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Client" WHERE "id"=${ids[0]} AND "deletedAt" IS NULL`;
  return live?.id ?? null;
}

/** Scoped native row. Instagram/Facebook/website keep the global (channel, peer)
 * key (partial unique index), so a different account with the same raw peer is
 * held there. WhatsApp has one chat per our number (see whatsappChatPerNumber). */
export async function ensureScopedBotConversation(db: ScopeDb, input: CustomerTransportEndpoint): Promise<{ id: string; accountId: string | null; transport: CustomerTransportReference }> {
  const endpoint = await ensureCustomerEndpoint(db, input);
  let clientId: string | null = null;
  if (endpoint.channel === "WHATSAPP" && !await findScopedBotConversation(input, db)) {
    // No DB key spans our numbers any more: serialize CREATION per raw peer (an
    // existing chat skips the lock), so the rule below and the kill switch cannot
    // be raced by two first messages to two numbers.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bot-conversation-wa-peer:${endpoint.subscriberId}`}))`;
    const rows = await readPeerChats(db, endpoint.channel, endpoint.subscriberId);
    const { own, blocking } = peerChatsForScope(endpoint.channel, rows, endpoint.endpointScopeId);
    if (!own.length) {
      if (blocking.length) throw new CustomerScopeDenied("compat_collision");
      clientId = await siblingWhatsappClient(db, rows);
    }
  } else if (endpoint.channel !== "WHATSAPP") {
    const [policy] = await db.$queryRaw<{ contractVersion: string }[]>`
      SELECT "contractVersion" FROM "CustomerRuntimePolicy" WHERE "id" = 'singleton'`;
    if (!policy || policy.contractVersion !== "scoped") {
      const collision = await db.$queryRaw<{ conflict: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "BotConversation" WHERE "channel" = ${endpoint.channel} AND "subscriberId" = ${endpoint.subscriberId}
          AND ("endpointScopeId" IS DISTINCT FROM ${endpoint.endpointScopeId} OR "accountId" IS DISTINCT FROM ${endpoint.accountId})) AS "conflict"`;
      if (collision[0]?.conflict) throw new CustomerScopeDenied("compat_collision");
    }
  }
  // Concurrent speculative inserts can collide with the scoped key (and, outside
  // WhatsApp, the global partial key); arbitrate without aborting the caller's
  // transaction. The exact scoped read below still rejects another installation:
  // no global-row fallback or account overwrite is permitted.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "BotConversation" ("id", "endpointScopeId", "channel", "subscriberId", "accountId", "clientId", "messages", "leadDraft", "updatedAt")
    VALUES (${randomUUID()}, ${endpoint.endpointScopeId}, ${endpoint.channel}, ${endpoint.subscriberId}, ${endpoint.accountId}, ${clientId},
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
