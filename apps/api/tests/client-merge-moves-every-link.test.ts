import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { clientPhoneHash } from "../src/lib/clientPhoneOrigins.js";
import { recordInvestigationSignal, decideInvestigation, syncLegacyInvestigationVerdict } from "../src/lib/investigationCases.js";

/**
 * СЛИЯНИЕ КАРТОЧЕК ПЕРЕНОСИТ ВСЕ ССЫЛКИ НА КЛИЕНТА (аудит 23.09.2026, №32).
 *
 * Объекты продавца, досье, вопросы собственнику оставались у дубля, который
 * уходит в Корзину: у основной карточки продавца «нет объекта». Первый тест
 * читает schema.prisma и требует, чтобы КАЖДАЯ ссылка на клиента была либо в
 * списке переносимых, либо в списке оставляемых с причиной — новая таблица не
 * проскочит молча.
 */

const { prisma } = await import("../src/db.js");
const { mergeClients, MERGE_LINKS_MOVED, MERGE_LINKS_LEFT_BEHIND } = await import("../src/lib/clientMerge.js");

function clientLinksInSchema(): string[] {
  const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const links = new Set<string>();
  for (const m of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const [, model, body] = m;
    for (const rel of body.matchAll(/\s\w+\s+Client\??\s+@relation\([^)]*fields:\s*\[(\w+)\]/g)) links.add(`${model}.${rel[1]}`);
    // Ссылки без объявленной связи — просто поле с id клиента. После типа —
    // пробел ИЛИ конец строки (B9, 02.10.2026): поле без комментария в конце
    // строки (`clientId        String`) прежний шаблон `[ \t]` пропускал, и
    // WhatsAppFirstContact.clientId выпал из сверки. Просмотр вперёд, а не
    // захват: съеденный перевод строки спрятал бы следующее поле.
    for (const f of body.matchAll(/\n\s+(\w*[cC]lientId)\s+String\??(?=[ \t\r\n])/g)) {
      // OAuth-идентификаторы внешних сервисов, не ссылки на клиента CRM.
      if (f[1] === "youtubeClientId" || f[1] === "yandexWebmasterClientId") continue;
      links.add(`${model}.${f[1]}`);
    }
  }
  return [...links].sort();
}

describe("Список переносимых при слиянии ссылок сверен со схемой", () => {
  it("каждая ссылка на клиента либо переносится, либо оставлена с причиной", () => {
    const known = new Set<string>([...MERGE_LINKS_MOVED, ...Object.keys(MERGE_LINKS_LEFT_BEHIND)]);
    const missing = clientLinksInSchema().filter((l) => !known.has(l));
    expect(missing).toEqual([]);
  });
});

const runId = Date.now();
const clientIds: string[] = [];
let agentId = "";
let districtId = "";
let propertyId = "";
const extraAgentIds: string[] = [];

afterAll(async () => {
  await prisma.investigationCase.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.jobApplication.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.contactProfile.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (agentId) await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.agent.deleteMany({ where: { id: { in: extraAgentIds } } });
});

describe("Слияние двух карточек продавца", () => {
  it("объект, бронь и досье дубля переезжают к основной карточке", async () => {
    const tail = String(runId).slice(-7);
    agentId = (
      await prisma.agent.create({ data: { fullName: `Агент слияния ${runId}`, phone: `+99295${tail}`, role: "AGENT", passwordHash: "x" } })
    ).id;
    districtId = (await prisma.district.create({ data: { name: `Район слияния ${runId}` } })).id;
    for (const p of [`+99293${tail}`, `+99294${tail}`]) await prisma.client.deleteMany({ where: { phone: p } });
    const primary = await prisma.client.create({
      data: { fullName: `Продавец ${runId}`, phone: `+99293${tail}`, source: "INSTAGRAM", kind: "SELLER", assignedAgentId: agentId },
    });
    const duplicate = await prisma.client.create({
      data: { fullName: `Продавец дубль ${runId}`, phone: `+99294${tail}`, source: "INSTAGRAM", kind: "SELLER", assignedAgentId: agentId, assignedAt: primary.assignedAt,
        extraPhones: [`+99271${tail}`, `+99272${tail}`] },
    });
    clientIds.push(primary.id, duplicate.id);
    propertyId = (
      await prisma.property.create({
        data: {
          title: `Объект слияния ${runId}`,
          type: "APARTMENT",
          areaSqm: 50,
          price: 40000,
          currency: "TJS",
          districtId,
          address: "Тестовая слияния, 1",
          condition: "GOOD",
          status: "AVAILABLE",
          assignedAgentId: agentId,
          sellerClientId: duplicate.id,
          reservedForClientId: duplicate.id,
        } as never,
      })
    ).id;
    const profile = await prisma.contactProfile.create({ data: { clientId: duplicate.id } as never });
    const jobApplication = await prisma.jobApplication.create({
      data: { clientId: duplicate.id, channel: "WHATSAPP", rawText: "тест: анкета дубля" } as never,
    });

    const waFirst = await prisma.whatsAppFirstContact.create({
      data: { clientId: duplicate.id, agentId, recipient: `99294${tail}`, templateName: "тест" },
    });

    const knownHash = clientPhoneHash(duplicate.extraPhones[0]), unknownHash = clientPhoneHash(duplicate.extraPhones[1]);
    const oldDate = new Date("2020-01-02T00:00:00Z");
    await prisma.clientPhoneOrigin.update({ where: { clientId_phoneHash: { clientId: duplicate.id, phoneHash: knownHash } }, data: { addedAt: oldDate, source: "MANUAL" } });
    await prisma.clientPhoneOrigin.deleteMany({ where: { clientId: duplicate.id, phoneHash: unknownHash } });
    const collisionHash = clientPhoneHash("+992700000001");
    const primaryOrigin = await prisma.clientPhoneOrigin.create({ data: { clientId: primary.id, phoneHash: collisionHash, addedAt: oldDate, source: "MANUAL" } });
    const sourceOrigin = await prisma.clientPhoneOrigin.create({ data: { clientId: duplicate.id, phoneHash: collisionHash, source: "UNKNOWN" } });
    const reportTarget = await prisma.ownerReportDelivery.create({ data: { propertyId, sellerClientId: primary.id, period: "2026-10", createdById: agentId } });
    const reportCollision = await prisma.ownerReportDelivery.create({ data: { propertyId, sellerClientId: duplicate.id, period: "2026-10", createdById: agentId } });
    const reportMoved = await prisma.ownerReportDelivery.create({ data: { propertyId, sellerClientId: duplicate.id, period: "2026-11", createdById: agentId } });
    const historical = await recordInvestigationSignal({ clientId: duplicate.id, assignmentAt: primary.assignedAt, subjectAgentId: agentId,
      sourceType: "MERGE_TEST", sourceId: randomUUID(), kind: "finding", independenceKey: randomUUID(), summary: "Synthetic historical evidence", occurredAt: new Date() });
    const beforeCase = await prisma.investigationCase.findUniqueOrThrow({ where: { id: historical.caseId }, include: { evidence: true } });
    const oldOpen = await recordInvestigationSignal({ clientId: duplicate.id, assignmentAt: primary.assignedAt, subjectAgentId: agentId, showingId: randomUUID(),
      sourceType: "MERGE_TEST", sourceId: randomUUID(), kind: "finding", independenceKey: randomUUID(), summary: "Other historical evidence", occurredAt: new Date() });
    await decideInvestigation({ caseId: historical.caseId, actorId: agentId, requestKey: randomUUID(), revision: 1, status: "REVIEWING", note: "Historical review preserved" });
    await prisma.client.update({ where: { id: primary.id }, data: { securityReview: "PENDING" } });
    await mergeClients(primary.id, duplicate.id, agentId, "тест: слияние продавцов");

    const known = await prisma.clientPhoneOrigin.findUniqueOrThrow({ where: { clientId_phoneHash: { clientId: primary.id, phoneHash: knownHash } } });
    expect(known.addedAt).toEqual(oldDate); expect(known.source).toBe("MANUAL");
    expect(await prisma.clientPhoneOrigin.findUnique({ where: { clientId_phoneHash: { clientId: primary.id, phoneHash: unknownHash } } })).toBeNull();
    expect((await prisma.clientPhoneOrigin.findUniqueOrThrow({ where: { id: primaryOrigin.id } })).addedAt).toEqual(oldDate);
    expect((await prisma.clientPhoneOrigin.findUniqueOrThrow({ where: { id: sourceOrigin.id } })).clientId).toBe(duplicate.id);
    expect((await prisma.ownerReportDelivery.findUniqueOrThrow({ where: { id: reportTarget.id } })).sellerClientId).toBe(primary.id);
    expect((await prisma.ownerReportDelivery.findUniqueOrThrow({ where: { id: reportCollision.id } })).sellerClientId).toBe(duplicate.id);
    expect((await prisma.ownerReportDelivery.findUniqueOrThrow({ where: { id: reportMoved.id } })).sellerClientId).toBe(primary.id);
    const afterCase = await prisma.investigationCase.findUniqueOrThrow({ where: { id: historical.caseId }, include: { evidence: true, decisions: true } });
    expect(afterCase.clientId).toBe(primary.id); expect(afterCase.caseKey).toBe(beforeCase.caseKey); expect(afterCase.assignmentAt).toEqual(primary.assignedAt);
    expect(afterCase.evidence).toEqual(beforeCase.evidence); expect(afterCase.decisions).toHaveLength(1);
    await prisma.$transaction(tx => syncLegacyInvestigationVerdict(tx, { clientId: primary.id, assignmentAt: primary.assignedAt, subjectAgentId: agentId, actorId: agentId, verdict: "CLEARED", note: "Primary verdict must not change historical duplicate case" }));
    expect((await prisma.investigationCase.findUniqueOrThrow({ where: { id: historical.caseId } })).status).toBe("REVIEWING");
    const decision = await decideInvestigation({ caseId: historical.caseId, actorId: agentId, requestKey: randomUUID(), revision: 2, status: "CONFIRMED", note: "Historical decision only" });
    expect(decision.mirrorWarning).toBeTruthy();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: primary.id } })).securityReview).toBe("PENDING");
    const ownCase = await recordInvestigationSignal({ clientId: primary.id, assignmentAt: primary.assignedAt, subjectAgentId: agentId,
      sourceType: "MERGE_TEST", sourceId: randomUUID(), kind: "finding", independenceKey: randomUUID(), summary: "Primary current case", occurredAt: new Date() });
    await decideInvestigation({ caseId: ownCase.caseId, actorId: agentId, requestKey: randomUUID(), revision: 1, status: "CLEARED", note: "Current case cleared independently" });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: primary.id } })).securityReview).toBe("CLEARED");
    expect((await prisma.investigationCase.findUniqueOrThrow({ where: { id: oldOpen.caseId } })).status).toBe("OPEN");

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(primary.id);
    expect(property.reservedForClientId).toBe(primary.id);
    const movedProfile = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(movedProfile.clientId).toBe(primary.id);
    const movedApplication = await prisma.jobApplication.findUniqueOrThrow({ where: { id: jobApplication.id } });
    expect(movedApplication.clientId).toBe(primary.id);
    const movedWa = await prisma.whatsAppFirstContact.findUniqueOrThrow({ where: { id: waFirst.id } });
    expect(movedWa.clientId).toBe(primary.id);
  });
  it("preserves a manual single role and cancelled task owners while moving live work", async () => {
    const former = await prisma.agent.create({ data: { fullName: "Former merge fixture owner", phone: `merge-former-${randomUUID()}`, passwordHash: "unused", role: "AGENT" } });
    extraAgentIds.push(former.id);
    const primary = await prisma.client.create({ data: { fullName: "Manual single-role buyer", phone: `merge-manual-${randomUUID()}`, source: "WALK_IN", kind: "BUYER", assignedAgentId: agentId,
      dualIntent: false, dualIntentDecisionSource: "MANUAL", dualIntentConfirmedAt: null } });
    const duplicate = await prisma.client.create({ data: { fullName: "Seller duplicate", phone: `merge-seller-${randomUUID()}`, source: "WALK_IN", kind: "SELLER", assignedAgentId: former.id } });
    clientIds.push(primary.id, duplicate.id);
    const taskIds: string[] = [];
    for (const [cancelled, robot] of [[true, false], [true, true], [false, false], [false, true]]) {
      const task = await prisma.interaction.create({ data: { clientId: duplicate.id, actorKind: robot ? "BOT" : "AGENT", agentId: robot ? null : former.id, subjectAgentId: robot ? former.id : null,
        type: "SYSTEM", notes: "Synthetic merge task", nextAction: "Synthetic follow-up", nextActionDate: new Date(Date.now() + 86400000), taskCancelledAt: cancelled ? new Date() : null } });
      taskIds.push(task.id);
    }
    await mergeClients(primary.id, duplicate.id, agentId, "Synthetic manual intent merge");
    const merged = await prisma.client.findUniqueOrThrow({ where: { id: primary.id } });
    expect(merged.dualIntent).toBe(false); expect(merged.dualIntentDecisionSource).toBe("MANUAL"); expect(merged.dualIntentConfirmedAt).toBeNull();
    for (const [index, id] of taskIds.entries()) {
      const task = await prisma.interaction.findUniqueOrThrow({ where: { id } });
      expect(task.clientId).toBe(primary.id);
      expect(index % 2 ? task.subjectAgentId : task.agentId).toBe(index < 2 ? former.id : agentId);
    }
  });
});
