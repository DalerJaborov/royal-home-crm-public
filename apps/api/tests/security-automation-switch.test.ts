import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * РУБИЛЬНИК «СЛУЖБА БЕЗОПАСНОСТИ: АВТОМАТИКА» (владелец 18.11.2026: «Нужно чтобы
 * таких больше не было и временно выключить всю логику сб можно? Просто чтобы
 * уведомление было руководителю тоже»). Повод — продавец ПР-000714: вердикт «вопросов
 * нет» закрыл карточку, хотя объект продавался.
 *
 * Два правила:
 *  1) выключено (умолчание после выката) — автоматика СБ карточку и агента не меняет,
 *     сигнал записан в дело и пришёл директору и РОП;
 *  2) вердикт СБ не закрывает карточку в работе, а «вопросов нет» — никогда.
 *
 * Общую строку Settings тест не переключает: положение рубильника подменяется только
 * в этом файле (`automation.on`), реальное чтение проверено отдельно.
 */
const automation = vi.hoisted(() => ({ on: undefined as boolean | undefined }));
vi.mock("../src/lib/securityAutomation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/securityAutomation.js")>();
  return {
    ...actual,
    securityAutomationOn: async (...args: Parameters<typeof actual.securityAutomationOn>) =>
      automation.on ?? actual.securityAutomationOn(...args),
  };
});
const sellerSwitch = vi.hoisted(() => ({ on: true }));
vi.mock("../src/lib/sellerSwitches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sellerSwitches.js")>()),
  sellerSwitchOn: async () => sellerSwitch.on,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { securityAutomationOn } = await import("../src/lib/securityAutomation.js");
const { escalateSellerPropertyMissing } = await import("../src/lib/sellerPropertyMissingAntifraud.js");
const { refuseClient } = await import("../src/lib/clientRefuse.js");
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");
const { dushanbeDateTimeString, dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DAY_MS = 86_400_000;
let districtId: string, agentId: string, directorId: string, ropId: string, directorToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

function workHoursNow(): Date {
  return dushanbeInputToDate(dushanbeDateTimeString(new Date()).slice(0, 10), "12:00");
}

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({ data: {
    fullName: `СБ-рубильник ${run}-${clientIds.length}`, phone: `+992917${run}${clientIds.length}`,
    source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date(), ...data,
  } as never });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(sellerClientId: string, status: "AVAILABLE" | "RESERVED" | "AWAITING_PHOTOS") {
  const p = await prisma.property.create({ data: {
    title: `Объект СБ ${run}-${propertyIds.length}`, type: "APARTMENT", areaSqm: 50, price: 60000, currency: "TJS",
    districtId, address: "Тест", condition: "GOOD", status, sellerClientId, intakeAgentId: agentId,
  } });
  propertyIds.push(p.id);
  return p;
}

function verdict(clientId: string, v: "CLEARED" | "CONFIRMED") {
  return request(app).post(`/api/v1/clients/${clientId}/security-review`)
    .set("Authorization", `Bearer ${directorToken}`).send({ verdict: v, note: "Проверено" });
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  districtId = (await prisma.district.create({ data: { name: `Район СБ ${run}` } })).id;
  const mk = (role: "AGENT" | "DIRECTOR" | "HEAD_OF_SALES", i: number) => prisma.agent.create({
    data: { fullName: `СБ ${role} ${run}`, phone: `+992918${run}${i}`, role, passwordHash: "test-hash" } });
  agentId = (await mk("AGENT", 1)).id;
  directorId = (await mk("DIRECTOR", 2)).id;
  ropId = (await mk("HEAD_OF_SALES", 3)).id;
  directorToken = signAccessToken({ sub: directorId, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId, ropId] } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "security-signal-" } } });
  const cases = await prisma.investigationCase.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
  await prisma.investigationDecision.deleteMany({ where: { caseId: { in: cases.map((c) => c.id) } } });
  await prisma.investigationEvidence.deleteMany({ where: { caseId: { in: cases.map((c) => c.id) } } });
  await prisma.investigationCase.deleteMany({ where: { id: { in: cases.map((c) => c.id) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("рубильник выключен — карточки не трогаем, руководству сигнал", () => {
  it("после миграции рубильник выключен (чтение из базы, без подмены)", async () => {
    automation.on = undefined;
    expect(await securityAutomationOn()).toBe(false);
  });

  it("антифрод «продавец без объекта»: без проверки СБ, уведомление директору и РОП, один раз", async () => {
    automation.on = false;
    const seller = await makeClient({ kind: "SELLER", propertyAcceptedAt: new Date(Date.now() - 30 * DAY_MS) });
    const before = await prisma.client.findUniqueOrThrow({ where: { id: seller.id } });

    await escalateSellerPropertyMissing(workHoursNow());
    await escalateSellerPropertyMissing(workHoursNow());

    const after = await prisma.client.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after.securityReview).toBeNull();
    expect(after.assignedAgentId).toBe(before.assignedAgentId);
    expect(after.assignedAt.getTime()).toBe(before.assignedAt.getTime());
    expect(after.deletedAt).toBeNull();
    expect(after.status).toBe(before.status);

    const alerts = await prisma.pendingDirectorAlert.findMany({ where: { tag: { startsWith: `security-signal-seller-property-missing:${seller.id}` } } });
    expect(alerts).toHaveLength(1);
    expect([...alerts[0].recipientRoles].sort()).toEqual(["DIRECTOR", "HEAD_OF_SALES"]);
    expect(alerts[0].excludeAgentId).toBe(agentId);

    // Сигнал не потерян: улика в деле СБ и закрытая запись в хронологии.
    const evidence = await prisma.investigationEvidence.findMany({ where: { case: { clientId: seller.id }, sourceType: "security-automation-off" } });
    expect(evidence).toHaveLength(1);
    expect(await prisma.interaction.count({ where: { clientId: seller.id, investigationOnly: true } })).toBe(1);

    // Доходит и до РОП (тег не из закрытых), а агенту, о ком сигнал, — нет.
    await flushDirectorAlertQueue(workHoursNow());
    const tag = alerts[0].tag!;
    expect(await prisma.notification.count({ where: { tag, agentId: directorId } })).toBe(1);
    expect(await prisma.notification.count({ where: { tag, agentId: ropId } })).toBe(1);
    expect(await prisma.notification.count({ where: { tag, agentId } })).toBe(0);
  });

  it("отказ агента с причиной для СБ: карточка у агента, без «на проверке», руководству сигнал", async () => {
    automation.on = false;
    const buyer = await makeClient({});
    const result = await refuseClient({ clientId: buyer.id, reason: "BOUGHT_SELF", initiator: "CLIENT",
      actorId: agentId, actorAgentId: agentId, bypassPreCloseGates: true, comment: "Купил сам" } as never);
    expect(result.ok).toBe(true);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(after.securityReview).toBeNull();
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.deletedAt).toBeNull();
    await vi.waitFor(async () => {
      expect(await prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `security-signal-refusal:${buyer.id}` } } })).toBe(1);
    });
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `security-review-${buyer.id}` } })).toBe(0);
  });

  it("вердикт «нарушение» при выключенной автоматике карточку не удаляет", async () => {
    automation.on = false;
    const buyer = await makeClient({ securityReview: "PENDING", assignmentRefusedAt: new Date(Date.now() - 3_600_000) });
    const res = await verdict(buyer.id, "CONFIRMED");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("осталась в работе");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.securityReview).toBe("CONFIRMED");
  });
});

describe("вердикт СБ не закрывает карточку в работе (случай ПР-000714)", () => {
  it("«вопросов нет» по продавцу с объектом в продаже — карточка остаётся в работе", async () => {
    automation.on = true;
    const seller = await makeClient({ kind: "SELLER", securityReview: "PENDING" });
    await makeProperty(seller.id, "AVAILABLE");
    const res = await verdict(seller.id, "CLEARED");
    expect(res.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.assignedAgentId).toBe(agentId);
    expect(after.securityReview).toBe("CLEARED");
  });

  it("«вопросов нет» не закрывает даже карточку без объектов и работы", async () => {
    automation.on = true;
    const buyer = await makeClient({ securityReview: "PENDING", assignmentRefusedAt: new Date(Date.now() - 3_600_000) });
    expect((await verdict(buyer.id, "CLEARED")).status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } })).deletedAt).toBeNull();
  });

  it.each(["AVAILABLE", "RESERVED", "AWAITING_PHOTOS"] as const)("«нарушение» по продавцу с объектом %s — не в Корзину", async (status) => {
    automation.on = true;
    const seller = await makeClient({ kind: "SELLER", securityReview: "PENDING" });
    await makeProperty(seller.id, status);
    const res = await verdict(seller.id, "CONFIRMED");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("осталась в работе");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: seller.id } })).deletedAt).toBeNull();
  });

  it("«нарушение», а агент работал с клиентом после постановки на проверку — не в Корзину", async () => {
    automation.on = true;
    const buyer = await makeClient({ securityReview: "PENDING", assignmentRefusedAt: new Date(Date.now() - 3_600_000) });
    await prisma.interaction.create({ data: { clientId: buyer.id, agentId, type: "CALL", notes: "Созвонились, ищем дальше" } });
    expect((await verdict(buyer.id, "CONFIRMED")).status).toBe(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } })).deletedAt).toBeNull();
  });

  it("«нарушение» без объекта, сделки и работы агента — карточка уходит в Корзину", async () => {
    automation.on = true;
    const buyer = await makeClient({ securityReview: "PENDING", assignmentRefusedAt: new Date(Date.now() - 3_600_000) });
    const res = await verdict(buyer.id, "CONFIRMED");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("Корзину");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: buyer.id } })).deletedAt).not.toBeNull();
  });
});
