import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { narrationHash } from "../propertyNarration.js";
import { mediaExecutionMode, mediaRecipientHash, ownerReportPeriod } from "../mediaExecution.js";
import { sendSms, toSmsPhone } from "../sms/index.js";
import { ownerReportUrl } from "./link.js";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
async function snapshot(tx: Tx, propertyId: string, now: Date) {
  const property = await tx.property.findUnique({ where: { id: propertyId } });
  const sub = await tx.ownerReportSubscription.findUnique({ where: { propertyId } });
  if (!property || property.deletedAt || property.status === "SOLD" || property.status === "WITHDRAWN" || !sub?.active || !sub.consentAt || sub.revokedAt || property.sellerClientId !== sub.sellerClientId) return null;
  const seller = await tx.client.findFirst({ where: { id: sub.sellerClientId, deletedAt: null }, select: { id: true, phone: true } });
  const phone = seller && toSmsPhone(seller.phone);
  const link = await tx.propertyOwnerReportLink.findFirst({ where: { propertyId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  if (!seller || !phone || !link) return null;
  const url = ownerReportUrl(link.token);
  if (!url.startsWith("https://")) return null;
  const period = ownerReportPeriod(now);
  const text = `Royal Home. Ежемесячный отчёт по объекту №${property.shortId} (${period}): ${url}`;
  return { sub, seller, phone, period, url, text, recipientHash: mediaRecipientHash(seller.id, phone.replace(/\D/g, "")), contentHash: narrationHash({ text, linkId: link.id }) };
}

/** A new explicit consent is bound to today's owner; previews never become live implicitly. */
export async function setOwnerReportConsent(propertyId: string, actorId: string, active: boolean) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const p = await tx.property.findUnique({ where: { id: propertyId } });
    if (!p || p.deletedAt) throw new Error("Объект недоступен");
    const existing = await tx.ownerReportSubscription.findUnique({ where: { propertyId } });
    if (!active && !existing) return null;
    // Revocation applies to the recorded owner even after unlink/reassignment.
    const sellerClientId = active ? p.sellerClientId : existing!.sellerClientId;
    if (!sellerClientId) throw new Error("У объекта нет действующего собственника");
    if (existing && existing.sellerClientId === p.sellerClientId && existing.active === active && existing.executionMode === mediaExecutionMode("OWNER_REPORT")) return existing;
    const now = new Date();
    const saved = await tx.ownerReportSubscription.upsert({ where: { propertyId },
      create: { propertyId, sellerClientId, active, consentAt: active ? now : null, consentById: actorId, revokedAt: active ? null : now, executionMode: mediaExecutionMode("OWNER_REPORT") },
      update: active ? { sellerClientId, active, revision: { increment: 1 }, consentAt: now, consentById: actorId, revokedAt: null, executionMode: mediaExecutionMode("OWNER_REPORT") } : { active: false, revision: { increment: 1 }, revokedAt: now },
    });
    await tx.auditLog.create({ data: { agentId: actorId, agentName: "Сотрудник CRM", action: active ? "OWNER_REPORT_CONSENT" : "OWNER_REPORT_CONSENT_REVOKED", entityType: "Property", entityId: propertyId,
      meta: { subscriptionId: saved.id, sellerClientId, revision: saved.revision, executionMode: saved.executionMode, active, previousRevision: existing?.revision ?? null, previousSellerClientId: existing?.sellerClientId ?? null, recordedAt: now.toISOString(), attestation: "RECORDED_BY_STAFF" } } });
    return saved;
  });
}

export async function prepareOwnerReportDelivery(propertyId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const s = await snapshot(tx, propertyId, now);
    if (!s) return null;
    const executionMode = s.sub.executionMode === "LIVE" && mediaExecutionMode("OWNER_REPORT") === "LIVE" ? "LIVE" : "PREVIEW";
    return tx.ownerReportDelivery.upsert({ where: { propertyId_sellerClientId_period: { propertyId, sellerClientId: s.seller.id, period: s.period } }, update: {},
      create: { propertyId, sellerClientId: s.seller.id, period: s.period, status: executionMode === "LIVE" ? "QUEUED" : "PREVIEW", executionMode, reportUrl: s.url,
        createdById: s.sub.consentById!, subscriptionVersion: s.sub.revision, recipientHash: s.recipientHash, contentHash: s.contentHash } });
  });
}

/** A claimed attempt is never retried, including a crash before its receipt was saved. */
export async function executeOwnerReportDelivery(id: string, now = new Date()) {
  if (mediaExecutionMode("OWNER_REPORT") !== "LIVE") return { status: "PREVIEW" };
  const claimStartedAt = new Date();
  const claim = await prisma.ownerReportDelivery.updateMany({ where: { id, status: "QUEUED", executionMode: "LIVE", period: ownerReportPeriod(now) }, data: { status: "SENDING", claimStartedAt } });
  if (!claim.count) return { status: "NOT_CLAIMED" };
  let attempted = false;
  try {
    const target = await prisma.$transaction(async tx => {
      const row = await tx.ownerReportDelivery.findUniqueOrThrow({ where: { id } });
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${row.propertyId} FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM "OwnerReportDelivery" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.ownerReportDelivery.findUniqueOrThrow({ where: { id } });
      if (current.status !== "SENDING" || current.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return null;
      const s = await snapshot(tx, row.propertyId, new Date());
      if (mediaExecutionMode("OWNER_REPORT") !== "LIVE" || !s || s.sub.executionMode !== "LIVE" || s.period !== row.period || s.sub.revision !== row.subscriptionVersion || s.seller.id !== row.sellerClientId || s.recipientHash !== row.recipientHash || s.contentHash !== row.contentHash) return null;
      return { phone: s.phone, text: s.text, sellerId: s.seller.id, propertyId: row.propertyId, actorId: row.createdById };
    });
    if (!target) {
      await prisma.ownerReportDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status: "CANCELLED", lastError: "Согласие, собственник, контакт, ссылка или период изменились" } });
      return { status: "CANCELLED" };
    }
    // No DB locks while awaiting Payom. Revocation cannot recall an already in-flight SMS.
    attempted = true;
    const result = await sendSms({ phone: target.phone, text: target.text, purpose: "OWNER_REPORT", clientId: target.sellerId, propertyId: target.propertyId, agentId: target.actorId, includeReceipt: true });
    const status = result.ok ? result.dryRun ? "PREVIEW" : result.providerMessageId ? "SENT" : "UNKNOWN" : result.failureOutcome === "refused" ? "FAILED" : "UNKNOWN";
    const receipt: Prisma.InputJsonValue = result.ok ? { smsMessageId: result.id, providerMessageId: result.providerMessageId ?? null, deliveryStatus: result.deliveryStatus ?? null, dryRun: result.dryRun ?? false, receivedAt: new Date().toISOString() } : { failureOutcome: result.failureOutcome ?? "unknown", receivedAt: new Date().toISOString() };
    const saved = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "OwnerReportDelivery" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.ownerReportDelivery.findUnique({ where: { id } });
      if (!current || current.claimStartedAt?.getTime() !== claimStartedAt.getTime()) return false;
      const previous = current.providerReceipt && typeof current.providerReceipt === "object" && !Array.isArray(current.providerReceipt) ? current.providerReceipt : {};
      const active = current.status === "SENDING";
      await tx.ownerReportDelivery.updateMany({ where: { id, claimStartedAt }, data: active ? { status, providerReceipt: receipt, lastError: result.ok ? null : result.error } : { providerReceipt: { ...previous, lateReceipt: receipt } } });
      return active;
    });
    return { status: saved ? status : "UNKNOWN" };
  } catch {
    const status = attempted ? "UNKNOWN" : "FAILED";
    await prisma.ownerReportDelivery.updateMany({ where: { id, status: "SENDING", claimStartedAt }, data: { status, lastError: attempted ? "Результат попытки требует проверки журнала провайдера; повтор отключён" : "Проверка перед отправкой не завершена; SMS не вызывался" } });
    return { status };
  }
}
export async function executeQueuedOwnerReports(now = new Date()) {
  if (mediaExecutionMode("OWNER_REPORT") !== "LIVE") return;
  await prisma.ownerReportDelivery.updateMany({ where: { status: "QUEUED", executionMode: "LIVE", period: { lt: ownerReportPeriod(now) } }, data: { status: "CANCELLED", lastError: "Период завершён; отчёты прошлых месяцев не досылаются" } });
  await prisma.ownerReportDelivery.updateMany({ where: { status: "SENDING", claimStartedAt: { lt: new Date(now.getTime() - 120_000) } }, data: { status: "UNKNOWN", lastError: "Прерванная попытка; нужна сверка с провайдером" } });
  const rows = await prisma.ownerReportDelivery.findMany({ where: { status: "QUEUED", executionMode: "LIVE", period: ownerReportPeriod(now) }, orderBy: { createdAt: "asc" }, take: 100, select: { id: true } });
  for (const row of rows) await executeOwnerReportDelivery(row.id, now);
}
