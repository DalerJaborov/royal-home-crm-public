import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СОБСТВЕННИК В КАРТОЧКЕ ОБЪЕКТА — ИМЕНЕМ И ССЫЛКОЙ (владелец 24.09.2026).
 *
 * GET /properties/:id отдаёт `sellerClient` — карточку продавца, к которой
 * привязан объект, — по тому же правилу, что и номер собственника: кому номер
 * скрыт, тому и имя. `canOpen` совпадает с тем, пустит ли GET /clients/:id.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail5 = String(runId).slice(-5);
const agentIds: string[] = [];
const clientIds: string[] = [];
let districtId = "";
let propertyId = "";
let sellerShortId = 0;
let intakeToken = "";
let strangerToken = "";
let directorToken = "";

async function agent(role: "AGENT" | "DIRECTOR", tail: string) {
  const a = await prisma.agent.create({
    data: { fullName: `Собственник-ссылка ${role} ${tail} ${runId}`, phone: `+99297${tail}${tail5}`, role, passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район собственника-ссылки ${runId}` } })).id;
  const intake = await agent("AGENT", "71");
  const sellerOwner = await agent("AGENT", "72");
  const stranger = await agent("AGENT", "73");
  const director = await agent("DIRECTOR", "74");
  intakeToken = signAccessToken({ sub: intake.id, role: "AGENT" });
  strangerToken = signAccessToken({ sub: stranger.id, role: "AGENT" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });

  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец Ссылкин ${runId}`,
      phone: `+99298${tail5}71`,
      source: "WALK_IN",
      kind: "SELLER",
      status: "NEW",
      assignedAgentId: sellerOwner.id,
    },
  });
  clientIds.push(seller.id);
  sellerShortId = seller.shortId;

  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект собственника-ссылки ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая собственника, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: intake.id,
        createdById: intake.id,
        ownerContact: `+99298${tail5}71`,
        sellerClientId: seller.id,
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [propertyId, `deal-history-${runId}`] } } });
  await prisma.interaction.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

const view = (token: string) =>
  request(app).get(`/api/v1/properties/${propertyId}`).set("Authorization", `Bearer ${token}`);

describe("Property deal history", () => {
  it("includes historical deal lifecycle events without exposing deal private metadata", async () => {
    await prisma.auditLog.createMany({ data: [
      { agentName: "QA history", action: "DEAL_COMPLETE", entityType: "Deal", entityId: `deal-history-${runId}`, meta: { propertyId, clientId: "private-client", commissionAmount: 9000, rejectReason: "private", from: "CONTRACT_SIGNED", to: "COMPLETED" } },
      { agentName: "QA history", action: "DEAL_PAYOUT", entityType: "Deal", entityId: `deal-history-${runId}`, meta: { propertyId, amount: 9000 } },
      { agentName: "QA history", action: "DEAL_CREATE", entityType: "Deal", entityId: `deal-history-${runId}`, meta: { propertyId: "another-property" } },
    ] });
    const response = await request(app).get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`).set("Authorization", `Bearer ${intakeToken}`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].action).toBe("DEAL_COMPLETE");
    expect(response.body.items[0].meta).toEqual({ from: "CONTRACT_SIGNED", to: "COMPLETED" });
    const page2 = await request(app).get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}&page=2`).set("Authorization", `Bearer ${intakeToken}`);
    expect(page2.body.total).toBe(1);
    expect(page2.body.items).toEqual([]);
  });
  it("still denies a stranger property history and the owner's broad deal audit", async () => {
    for (const [token, query] of [[strangerToken, `entityType=Property&entityId=${propertyId}`], [intakeToken, "entityType=Deal"]]) {
      const response = await request(app).get(`/api/v1/audit-log?${query}`).set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(403);
    }
  });
});

describe("Собственник в карточке объекта", () => {
  it("карточка считает состоявшиеся показы, исключая будущее, отмену и скрытую проверку", async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 86400_000);
    const base = { clientId: clientIds[0], agentId: agentIds[0], propertyId, type: "SHOWING" as const,
      showingEvidenceVersion: 1, notes: "Synthetic property card showing count" };
    await prisma.property.update({ where: { id: propertyId }, data: { viewsCount: 99 } });
    await prisma.interaction.createMany({ data: [
      { ...base, nextActionDate: past, completedAt: past },
      { ...base, nextActionDate: future },
      { ...base, nextActionDate: past, declinedAt: past },
      { ...base, nextActionDate: past, taskCancelledAt: past },
      { ...base, nextActionDate: past, investigationOnly: true },
    ] });
    const res = await view(strangerToken);
    expect(res.status).toBe(200);
    expect(res.body.conductedShowingsCount).toBe(1);
    expect(res.body).not.toHaveProperty("interactions");
    // Neither the obsolete counter nor a truncated history supplies this fact.
    expect(res.body.viewsCount).toBe(99);
  });
  it("руководитель видит имя продавца и может открыть его карточку", async () => {
    const res = await view(directorToken);
    expect(res.status).toBe(200);
    expect(res.body.sellerClient).toEqual({
      id: clientIds[0],
      shortId: sellerShortId,
      fullName: `Продавец Ссылкин ${runId}`,
      canOpen: true,
    });
  });

  it("агент, принявший объект, видит имя, но продавец закреплён за другим — ссылки нет", async () => {
    const res = await view(intakeToken);
    expect(res.status).toBe(200);
    expect(res.body.ownerContactHidden).toBe(false);
    expect(res.body.sellerClient?.fullName).toBe(`Продавец Ссылкин ${runId}`);
    expect(res.body.sellerClient?.canOpen).toBe(false);
    // Правило то же, что у самой карточки клиента: она ему правда не откроется.
    const card = await request(app).get(`/api/v1/clients/${sellerShortId}`).set("Authorization", `Bearer ${intakeToken}`);
    expect(card.status).toBe(403);
  });

  it("кому номер собственника скрыт, тому не отдаётся и имя", async () => {
    const res = await view(strangerToken);
    expect(res.status).toBe(200);
    expect(res.body.ownerContactHidden).toBe(true);
    expect(res.body.sellerClient).toBeNull();
  });

  it("число «покупателей ждут» приходит с карточкой, тем же подсчётом, что у списка", async () => {
    const buyer = await prisma.client.create({
      data: {
        fullName: `Покупатель под объект ${runId}`,
        phone: `+99298${tail5}72`,
        source: "WALK_IN",
        kind: "BUYER",
        status: "HOT",
        workStatus: "ACTIVE",
        desiredDistrictId: districtId,
        desiredType: "APARTMENT",
        budgetMax: 100000,
        currency: "TJS",
        lastContactAt: new Date(),
      } as never,
    });
    clientIds.push(buyer.id);
    const res = await view(directorToken);
    expect(res.status).toBe(200);
    const { computeDemandCounts } = await import("../src/routes/matching.js");
    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    const expected = (await computeDemandCounts([property])).get(propertyId) ?? 0;
    expect(expected).toBeGreaterThanOrEqual(1);
    expect(res.body.demandCount).toBe(expected);
  });

  it("карточка продавца в корзине — имени нет, битой ссылки тоже", async () => {
    await prisma.client.update({ where: { id: clientIds[0] }, data: { deletedAt: new Date() } });
    try {
      const res = await view(directorToken);
      expect(res.status).toBe(200);
      expect(res.body.sellerClient).toBeNull();
    } finally {
      await prisma.client.update({ where: { id: clientIds[0] }, data: { deletedAt: null } });
    }
  });
});
