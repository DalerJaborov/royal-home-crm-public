import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Объект, снятый с продажи, обязан исчезнуть с сайта.
 *
 * До 08.08.2026 смену статуса на сайт передавала только продажа: «Снято с продажи»
 * оставалось внутренним делом CRM, а объявление на royalhome.tj жило дальше — по
 * нему звонили покупатели, хотя собственник уже забрал квартиру. Тест стережёт
 * само действие («unpublish», а не бейдж «Продано») и отметку publishedOnSite,
 * без которой карточка считалась бы опубликованной и после снятия.
 */

const syncPropertiesToSite = vi.fn(async () => ({ ok: true as const, results: [{ ok: true as const, shortId: 1 }] }));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";
const phone = `+99291${runId.toString().slice(-7)}`;

let districtId: string;
let token: string;
let agentId: string;
const propertyIds: string[] = [];
const buyerIds: string[] = [];

async function seedPublished(status: "AVAILABLE" | "SOLD") {
  const property = await prisma.property.create({
    data: {
      title: `Снятие-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 4",
      condition: "GOOD",
      status,
      publishedOnSite: true,
    },
  });
  propertyIds.push(property.id);
  return property;
}

/** Отметка снимается фоново, уже после ответа — ждём её, а не гадаем. */
async function publishedOnSiteAfter(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const property = await prisma.property.findUnique({ where: { id }, select: { publishedOnSite: true } });
    if (property && !property.publishedOnSite) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** closePropertySummary — тоже фоном, после ответа (тот же приём best-effort). */
async function summaryDoneAtAfter(summaryId: string): Promise<Date | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const summary = await prisma.pendingSummary.findUnique({ where: { id: summaryId }, select: { doneAt: true } });
    if (summary?.doneAt) return summary.doneAt;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Снятие-${runId}` } });
  districtId = district.id;
  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ снятия",
      phone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  agentId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  token = res.body.accessToken;
});

beforeEach(() => {
  syncPropertiesToSite.mockClear();
});

afterAll(async () => {
  await prisma.pendingSummary.deleteMany({ where: { kind: "property", subjectId: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: buyerIds } } });
  await prisma.agent.deleteMany({ where: { phone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Снятие с продажи доходит до сайта", () => {
  it("объявление снимается, отметка о публикации сбрасывается", async () => {
    const property = await seedPublished("AVAILABLE");

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "WITHDRAWN" });

    expect(res.status).toBe(200);
    expect(syncPropertiesToSite).toHaveBeenCalledWith(expect.anything(), "unpublish");
    expect(await publishedOnSiteAfter(property.id)).toBe(false);
  });

  it("снятие проданного объекта убирает объявление, а не оживляет его", async () => {
    const property = await seedPublished("SOLD");

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "WITHDRAWN" });

    expect(res.status).toBe(200);
    expect(syncPropertiesToSite).toHaveBeenCalledWith(expect.anything(), "unpublish");
  });

  it("обычная продажа по-прежнему вешает бейдж, а не снимает объявление", async () => {
    const property = await seedPublished("AVAILABLE");
    // «Продано» вручную — только при завершённой сделке (находка №182).
    const buyer = await prisma.client.create({
      data: { fullName: `Покупатель снятия ${runId}`, phone: `+99293${String(runId).slice(-7)}`, source: "PHONE_CALL" },
    });
    buyerIds.push(buyer.id);
    await prisma.deal.create({ data: { clientId: buyer.id, propertyId: property.id, agentId, stage: "COMPLETED" } });

    const res = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "SOLD" });

    expect(res.status).toBe(200);
    expect(syncPropertiesToSite).toHaveBeenCalledWith(expect.anything(), "sold");
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.publishedOnSite).toBe(true);
  });
});

