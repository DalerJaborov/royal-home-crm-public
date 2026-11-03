import { prisma } from "../../db.js";
import { isNewAfterActivation } from "./freshness.js";
import { nextSomonAgent } from "./roundRobin.js";
import { somonKeyFingerprint, somonPhoneHash } from "./contactIdentity.js";
import { findPhoneOwners } from "../clientPhones.js";
import { Prisma } from "../../generated/prisma/client.js";
import { loadStaffPhoneChecker } from "../staffPhoneGuard.js";
import { SOMON_SIGHTING_RETENTION_DAYS } from "./phoneSighting.js";
import { SOMON_SELLER_UNKNOWN, SOMON_SELLER_UNKNOWN_DAYS } from "./sellerCount.js";

type Reservation = { status: "reserved"; agentId: string; chatId: string } | { status: "disabled" | "not_new" | "duplicate" | "known_contact" | "no_agent" };
export type DateEvidence = { kind: "verified"; publishedAt: Date } | { kind: "uncertain" };

/** Atomically reserve an advert and advance the separate Somon queue. Once reserved,
 * a crash or an ambiguous Telegram response must never trigger an automatic resend. */
const MAX_PUBLICATION_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
export async function reserveSomonDelivery(advertId: string, phone: string, evidence: DateEvidence, now = new Date()): Promise<Reservation> {
  if (!/^\d{1,20}$/.test(advertId)) throw new Error("Invalid Somon advert ID");
  const phoneHash = somonPhoneHash(phone);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const state = await tx.somonMonitor.findUnique({ where: { id: "singleton" } });
    if (!state?.enabled || !state.activatedAt || !state.baselineAt || state.contactKeyFingerprint !== somonKeyFingerprint()) return { status: "disabled" };
    const existingDelivery = await tx.somonDelivery.findUnique({ where: { advertId }, select: { status: true } });
    if (existingDelivery && !["FAILED", "CANCELLED"].includes(existingDelivery.status)) return { status: "duplicate" };
    const seen = await tx.somonSeenAdvert.findUnique({ where: { advertId } });
    if (!seen || seen.baseline || seen.seenAt <= state.baselineAt || seen.status !== "PENDING") return { status: "not_new" };
    if (evidence.kind === "verified" && !isNewAfterActivation(state.activatedAt, evidence.publishedAt)) return { status: "not_new" };
    const age = now.getTime() - (evidence.kind === "verified" ? evidence.publishedAt : seen.seenAt).getTime();
    if (!Number.isFinite(age) || age > MAX_PUBLICATION_AGE_MS || age < -MAX_CLOCK_SKEW_MS) return { status: "not_new" };
    const existingContact = await tx.somonContactReceipt.findUnique({ where: { phoneHash } });
    const knownClients = await findPhoneOwners([phone], { db: tx, includeDeleted: true, limit: 1 });
    // Номер действующего сотрудника — не продавец: тот же сторож, что и во всех путях CRM.
    // Номеров офиса в Settings нет (явных полей телефона компании в схеме не найдено).
    const staffMatch = (await loadStaffPhoneChecker(tx))([phone]);
    if (existingContact || knownClients.length || staffMatch) {
      await tx.somonSeenAdvert.update({ where: { advertId }, data: { status: "KNOWN_CONTACT", slug: null, sellerCheck: Prisma.DbNull } });
      return { status: "known_contact" };
    }
    const recipients = await tx.somonRecipient.findMany({ orderBy: { position: "asc" } });
    const agents = await tx.agent.findMany({ where: { id: { in: recipients.map(x => x.agentId) }, isActive: true, role: "AGENT", telegramChatId: { not: null } }, select: { id: true, telegramChatId: true } });
    const lookup = new Map(agents.map(a => [a.id, a]));
    const next = nextSomonAgent(recipients.map(r => ({ id: r.agentId, enabled: r.enabled, active: lookup.has(r.agentId), linked: !!lookup.get(r.agentId)?.telegramChatId })), state.lastAssignedAgentId);
    const agent = next ? lookup.get(next) : null;
    if (!agent?.telegramChatId) return { status: "no_agent" };
    await tx.somonDelivery.upsert({ where: { advertId }, create: { advertId, agentId: agent.id, status: "SENDING", dateUncertain: evidence.kind === "uncertain" }, update: { agentId: agent.id, status: "SENDING", dateUncertain: evidence.kind === "uncertain" } });
    await tx.somonContactReceipt.create({ data: { phoneHash, agentId: agent.id, advertId } });
    await tx.somonSeenAdvert.update({ where: { advertId }, data: { status: "DISPATCHED", sellerCheck: Prisma.DbNull } });
    await tx.somonMonitor.update({ where: { id: "singleton" }, data: { lastAssignedAgentId: agent.id } });
    return { status: "reserved", agentId: agent.id, chatId: agent.telegramChatId };
  }, { timeout: 35000 });
}

/** Accepted receipts can be removed after the admission window; unresolved
 * attempts remain until reviewed, since the message may have been delivered. */
export async function cleanupSomonReceipts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = await prisma.somonDelivery.deleteMany({ where: { status: { in: ["ACCEPTED", "REVIEWED"] }, updatedAt: { lt: cutoff } } });
  const sightingCutoff = new Date(now.getTime() - SOMON_SIGHTING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.somonPhoneSighting.deleteMany({ where: { seenAt: { lt: sightingCutoff } } });
  // Не дождались автора за 3 дня — EXPIRED, ссылку забываем (дальше — обычная чистка через 180 дней).
  const unknownCutoff = new Date(now.getTime() - SOMON_SELLER_UNKNOWN_DAYS * 24 * 60 * 60 * 1000);
  await prisma.somonSeenAdvert.updateMany({ where: { status: SOMON_SELLER_UNKNOWN, seenAt: { lt: unknownCutoff } }, data: { status: "EXPIRED", slug: null, sellerCheck: Prisma.DbNull } });
  const seenCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  await prisma.$executeRaw`DELETE FROM "SomonSeenAdvert" s
    WHERE s."baseline" = false AND s."seenAt" < ${seenCutoff}
      AND s."status" IN ('REJECTED', 'REVIEW_SELLER', 'KNOWN_CONTACT', 'NO_PHONE', 'EXPIRED', 'UNAVAILABLE', 'INVALID', 'DISPATCHED')
      AND NOT EXISTS (SELECT 1 FROM "SomonDelivery" d WHERE d."advertId" = s."advertId" AND d."status" IN ('SENDING', 'UNKNOWN', 'FAILED', 'CANCELLED'))`;
  return result.count;
}

/** ACCEPTED is only recorded after a successful Telegram response; any uncertain
 * outcome remains UNKNOWN and requires human review rather than automatic retry. */
export async function finishSomonDelivery(advertId: string, outcome: "ACCEPTED" | "UNKNOWN" | "FAILED"): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const result = await tx.somonDelivery.updateMany({ where: { advertId, status: "SENDING" }, data: { status: outcome } });
    if (result.count === 1 && outcome === "ACCEPTED") await tx.somonSeenAdvert.updateMany({ where: { advertId }, data: { slug: null } });
    return result.count === 1;
  });
}
