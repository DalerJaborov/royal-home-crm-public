import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recruitmentRecoveryRequestSchema, parsePermissionOverrides, resolvePermissions, ROLES,
  type RecruitmentRecoveryRequest } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { readCustomerOpenVacancies } from "./recruitmentPositions.js";
import { recruitmentRecoveryHash, recruitmentRecoveryReply } from "../ai/recruitmentRecoveryReply.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { lockCustomerStateSnapshot } from "./customerState.js";
import { loadCustomerTransportForConversation, type CustomerTransportReference } from "./customerConversationScope.js";
import { loadBotChannelToggles, asBotChannel } from "../messengers/botChannels.js";
import { sendMessage, asMetaChannel } from "../messengers/meta.js";
import { withCustomerDeliveryTransport, CustomerDeliveryHeldError } from "./customerDeliveryTransport.js";
import { appendConversationMessagesInTransaction } from "../messengers/appendMessages.js";
import { publishMessageNew } from "./livePublish.js";

type RecoveryRow = { id: string; campaign: string; conversationId: string; endpointScopeId: string; transportJson: unknown;
  fenceJson: unknown; sourceHash: string; sourceAt: Date; catalogHash: string; payloadEncrypted: string; payloadHash: string;
  actorId: string; status: string; providerMid: string | null; attemptAt: Date | null; finishedAt: Date | null; projectionAt: Date | null };
const nativeSelect = { id: true, channel: true, subscriberId: true, accountId: true, endpointScopeId: true, messages: true,
  lastMessageAt: true, pausedUntil: true, botPausedAt: true, optedOutAt: true, propertyChatAgentId: true, client: { select: { deletedAt: true } } } as const;
function actorAllowed(actor: { role: string; permissions: unknown; isActive: boolean } | null): boolean {
  const role = ROLES.find(value => value === actor?.role);
  const permissions = role && actor ? resolvePermissions(role, parsePermissionOverrides(actor.permissions)) : null;
  return !!actor?.isActive && !!role && ["ADMIN", "DIRECTOR"].includes(role) && !!permissions?.has("settings.manage") && permissions.has("messages.view");
}
async function latestTarget(db: TxClient, conversationId: string, now: number, allowNativePause = false, includeReady = true) {
  if (!await lockCustomerNative(db, { kind: "bot", id: conversationId })) return null;
  const row = await db.botConversation.findUnique({ where: { id: conversationId }, select: nativeSelect });
  const messages = row && Array.isArray(row.messages) ? row.messages : [];
  const lastUser = [...messages].reverse().find(value => value && typeof value === "object" && !Array.isArray(value) && value.role === "user");
  const inboundAt = lastUser && typeof lastUser === "object" && !Array.isArray(lastUser) && typeof lastUser.at === "string" ? Date.parse(lastUser.at) : NaN;
  if (!row || !row.endpointScopeId || !row.lastMessageAt || row.lastMessageAt.getTime() > now ||
      !Number.isFinite(inboundAt) || inboundAt > now || now - inboundAt >= 24 * 60 * 60_000 - 60_000 || row.optedOutAt || row.propertyChatAgentId || row.client?.deletedAt ||
      !allowNativePause && row.pausedUntil && row.pausedUntil.getTime() > now || !asMetaChannel(row.channel)) return null;
  const state = await lockCustomerStateSnapshot(db, { conversationId });
  // An explicit owner correction is a new outbound purpose, not a replay of
  // an expired customer turn. It never clears a HUMAN lease/hold or changes lane.
  if (!state || state.closedAt || state.ownerMode !== "BOT") return null;
  const unknown = await db.customerOutboxPart.count({ where: { conversationId,
    status: { in: includeReady ? ["READY", "UNKNOWN", "IN_FLIGHT"] : ["UNKNOWN", "IN_FLIGHT"] }, createdAt: { gte: new Date(now - 3 * 86400_000) } } });
  if (unknown) return null;
  return { row, fence: state.fence, inboundAt };
}

/** Genuine authenticated owner action creates a bounded one-time BOT campaign.
 * Callers pass native IDs selected during human review, never arbitrary peers,
 * tokens, prose, permissions or simulated inbound events. */
export async function enqueueRecruitmentRecovery(actorId: string, raw: unknown) {
  const request: RecruitmentRecoveryRequest = recruitmentRecoveryRequestSchema.parse(raw);
  const actor = await prisma.agent.findUnique({ where: { id: actorId }, select: { role: true, permissions: true, isActive: true, fullName: true } });
  if (!actorAllowed(actor)) throw new Error("Owner permission required");
  const catalog = await readCustomerOpenVacancies();
  const result: Array<{ conversationId: string; status: string; id?: string }> = [];
  for (const recipient of request.recipients) {
    const text = recruitmentRecoveryReply(catalog, recipient);
    const transport = await loadCustomerTransportForConversation(recipient.conversationId);
    if (!text || !transport) { result.push({ conversationId: recipient.conversationId, status: "catalog_or_transport_unavailable" }); continue; }
    const created = await prisma.$transaction(async tx => {
      if (!await lockCustomerNative(tx, { kind: "bot", id: recipient.conversationId })) return { conversationId: recipient.conversationId, status: "native_missing" };
      const existing = await tx.$queryRaw<RecoveryRow[]>`SELECT * FROM "RecruitmentRecovery" WHERE "originalConversationId"=${recipient.conversationId}`;
      if (existing[0]) return { conversationId: recipient.conversationId, status: existing[0].status, id: existing[0].id };
      let target = await latestTarget(tx, recipient.conversationId, Date.now(), true);
      if (!target || transport.endpointScopeId !== target.row.endpointScopeId || transport.channel !== target.row.channel || transport.accountId !== target.row.accountId) {
        return { conversationId: recipient.conversationId, status: "window_owner_or_delivery_hold" };
      }
      let runAt: Date | undefined;
      if (recruitmentRecoveryHash(target.row.messages) !== recipient.expectedSourceHash ||
          target.row.lastMessageAt!.getTime() !== Date.parse(recipient.expectedSourceAt)) {
        return { conversationId: recipient.conversationId, status: "reviewed_context_changed" };
      }
      if (target.row.pausedUntil && target.row.pausedUntil.getTime() > Date.now()) {
        if (recipient.resumeReviewedPause) {
          // Fresh explicit ADMIN/DIRECTOR action, equivalent to the existing
          // "return to bot" control. Not a resurrected old shield/customer grant.
          // latestTarget already rejected HUMAN/HOLD/opt-out/assigned staff.
          const until = target.row.pausedUntil, since = target.row.botPausedAt;
          await tx.botConversation.update({ where: { id: target.row.id }, data: { pausedUntil: null, botPausedAt: null } });
          if (since) await tx.outboundShieldState.updateMany({ where: { endpointScopeId: target.row.endpointScopeId!,
            channel: target.row.channel, subscriberId: target.row.subscriberId, pausedUntil: until, pausedAt: since, pausedReason: "repeat" },
            data: { pausedUntil: null, pausedAt: null, pausedReason: null, pauseFence: Prisma.DbNull } });
          await tx.auditLog.create({ data: { agentId: actorId, agentName: actor!.fullName, action: "RECRUITMENT_REVIEWED_BOT_RESUME",
            entityType: "BotConversation", entityId: target.row.id, meta: { campaign: request.campaign, authority: "explicit_owner_review" } } });
          target = await latestTarget(tx, recipient.conversationId, Date.now());
          if (!target) throw new Error("Reviewed resumption changed controller");
        } else {
          const due = target.row.pausedUntil.getTime() + 60_000;
          if (due >= target.inboundAt + 24 * 60 * 60_000 - 60_000) return { conversationId: recipient.conversationId, status: "pause_beyond_reply_window" };
          // Do not interrupt a bounded staff pause. A later native message,
          // owner change or catalog update will invalidate this exact source.
          runAt = new Date(due);
        }
      }
      const id = randomUUID(), hash = recruitmentRecoveryHash({ text });
      await tx.$executeRaw`INSERT INTO "RecruitmentRecovery" ("id","campaign","originalConversationId","conversationId","endpointScopeId","transportJson","fenceJson",
        "sourceHash","sourceAt","catalogHash","payloadEncrypted","payloadHash","actorId") VALUES (${id},${request.campaign},${recipient.conversationId},${recipient.conversationId},
        ${transport.endpointScopeId},${JSON.stringify(transport)}::jsonb,${JSON.stringify(target.fence)}::jsonb,
        ${recruitmentRecoveryHash(target.row.messages)},${target.row.lastMessageAt!},${catalog.sourceHash},${encryptSecret(text)},${hash},${actorId})`;
      await tx.backgroundJob.create({ data: { type: "recruitment-recovery", payload: { version: 1, id },
        dedupeKey: `recruitment-recovery:${id}`, maxAttempts: 1, ...(runAt ? { runAt } : {}) } });
      await tx.auditLog.create({ data: { agentId: actorId, agentName: actor!.fullName, action: "RECRUITMENT_CORRECTION_APPROVED",
        entityType: "RecruitmentRecovery", entityId: id, meta: { campaign: request.campaign, purpose: recipient.reason, catalogHash: catalog.sourceHash } } });
      return { conversationId: recipient.conversationId, status: "READY", id, ...(runAt ? { scheduledAt: runAt.toISOString() } : {}) };
    });
    result.push(created);
  }
  return { items: result };
}

async function current(row: RecoveryRow, claim = false): Promise<boolean> {
  const [actor, catalog, transport, toggles] = await Promise.all([
    prisma.agent.findUnique({ where: { id: row.actorId }, select: { role: true, permissions: true, isActive: true } }),
    readCustomerOpenVacancies(), loadCustomerTransportForConversation(row.conversationId), loadBotChannelToggles()]);
  const channel = transport && asBotChannel(transport.channel);
  if (!actorAllowed(actor) || catalog.sourceHash !== row.catalogHash || !transport || !isDeepStrictEqual(JSON.parse(JSON.stringify(transport)), row.transportJson) || !channel || !toggles.channels[channel]) return false;
  return prisma.$transaction(async tx => {
    const target = await latestTarget(tx, row.conversationId, Date.now(), false, claim);
    const valid = !!target && isDeepStrictEqual(target.fence, row.fenceJson) && target.row.endpointScopeId === row.endpointScopeId &&
      target.row.lastMessageAt?.getTime() === row.sourceAt.getTime() && recruitmentRecoveryHash(target.row.messages) === row.sourceHash;
    if (!valid || !claim) return valid;
    // Same native/state locks as ordinary dispatcher claims: only one purpose
    // can enter physical delivery for this exact controller snapshot.
    return await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='IN_FLIGHT',"attemptAt"=now() WHERE "id"=${row.id} AND "status"='READY'` === 1;
  });
}
async function settle(id: string, status: "ACCEPTED" | "UNKNOWN" | "SUPPRESSED", mid: string | null, reason: string | null) {
  await prisma.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"=${status},"providerMid"=${mid},"finishedAt"=now(),"reason"=${reason}
    WHERE "id"=${id} AND "status"='IN_FLIGHT'`;
}
export async function closeInterruptedRecruitmentRecovery(id: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"=CASE WHEN "status"='IN_FLIGHT' THEN 'UNKNOWN' ELSE 'SUPPRESSED' END,
    "finishedAt"=now(),"reason"='job_interrupted' WHERE "id"=${id} AND "status" IN ('READY','IN_FLIGHT')`;
}
async function project(row: RecoveryRow, text: string) {
  const projected = await prisma.$transaction(async tx => {
    if (!await lockCustomerNative(tx, { kind: "bot", id: row.conversationId })) return false;
    const [fresh] = await tx.$queryRaw<RecoveryRow[]>`SELECT * FROM "RecruitmentRecovery" WHERE "id"=${row.id} FOR UPDATE`;
    if (!fresh || fresh.status !== "ACCEPTED" || !fresh.providerMid || fresh.projectionAt) return false;
    const native = await tx.botConversation.findUnique({ where: { id: row.conversationId }, select: nativeSelect });
    if (!native || native.endpointScopeId !== row.endpointScopeId || !fresh.finishedAt) return false;
    await appendConversationMessagesInTransaction(tx, row.conversationId, [{ role: "assistant", by: { kind: "bot" }, content: text,
      mid: fresh.providerMid, at: fresh.finishedAt.toISOString() }]);
    await tx.$executeRaw`UPDATE "RecruitmentRecovery" SET "projectionAt"=now() WHERE "id"=${row.id}`;
    return true;
  });
  if (projected) void publishMessageNew("bot", row.conversationId, "OUT");
}

/** No automatic physical retry. A crash after CAS means UNKNOWN/attention,
 * never permission to resend. Provider hooks disable legacy POST retries. */
export async function runRecruitmentRecovery(id: string): Promise<void> {
  const [row] = await prisma.$queryRaw<RecoveryRow[]>`SELECT * FROM "RecruitmentRecovery" WHERE "id"=${id}`;
  if (!row) return;
  if (!row.conversationId) {
    await prisma.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='SUPPRESSED',"reason"='native_deleted',"finishedAt"=now() WHERE "id"=${id} AND "status"='READY'`;
    return;
  }
  const text = decryptSecret(row.payloadEncrypted);
  if (recruitmentRecoveryHash({ text }) !== row.payloadHash) throw new Error("Recovery integrity mismatch");
  if (row.status === "ACCEPTED") { await project(row, text); return; }
  if (row.status === "IN_FLIGHT") {
    if (row.attemptAt && Date.now() - row.attemptAt.getTime() > 120_000) await settle(id, "UNKNOWN", null, "interrupted_attempt");
    return;
  }
  if (row.status !== "READY") return;
  if (!await current(row, true)) {
    await prisma.$executeRaw`UPDATE "RecruitmentRecovery" SET "status"='SUPPRESSED',"reason"='context_changed',"finishedAt"=now() WHERE "id"=${id} AND "status"='READY'`; return;
  }
  const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: row.conversationId }, select: { channel: true, subscriberId: true } });
  const channel = asMetaChannel(native.channel); if (!channel) throw new Error("Unsupported recovery channel");
  try {
    await withCustomerDeliveryTransport({
      beforePost: async () => {
        const [attempt] = await prisma.$queryRaw<RecoveryRow[]>`SELECT * FROM "RecruitmentRecovery" WHERE "id"=${id}`;
        if (!attempt || attempt.status !== "IN_FLIGHT" || !attempt.attemptAt || Date.now() - attempt.attemptAt.getTime() > 60_000 ||
          !await current(row)) throw new CustomerDeliveryHeldError("recovery_context_changed");
      },
      accepted: async mid => { if (mid) await settle(id, "ACCEPTED", mid, null); else await settle(id, "UNKNOWN", null, "missing_provider_receipt"); },
      rejected: async status => { await settle(id, "SUPPRESSED", null, `provider_${status}`); },
      networkFailure: async () => { await settle(id, "UNKNOWN", null, "transport_unknown"); },
    }, () => sendMessage(channel, native.subscriberId, text, undefined, { origin: "bot", transport: row.transportJson as CustomerTransportReference }));
  } catch (error) {
    await settle(id, error instanceof CustomerDeliveryHeldError ? "SUPPRESSED" : "UNKNOWN", null,
      error instanceof CustomerDeliveryHeldError ? "context_changed_before_post" : "transport_or_settlement_unknown");
  }
  const [fresh] = await prisma.$queryRaw<RecoveryRow[]>`SELECT * FROM "RecruitmentRecovery" WHERE "id"=${id}`;
  if (fresh?.status === "ACCEPTED") await project(fresh, text);
}
