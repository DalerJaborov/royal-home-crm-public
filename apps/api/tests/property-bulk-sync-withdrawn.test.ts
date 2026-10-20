import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * СНЯТЫЙ С ПРОДАЖИ ИЛИ ЗАРЕЗЕРВИРОВАННЫЙ ОБЪЕКТ НА САЙТ НЕ ВЫХОДИТ (ночная
 * проверка 24.09.2026, №129).
 *
 * POST /properties/bulk-sync {action:"publish"} проверял только конвейер
 * подготовки (isPipelineStatus — до AVAILABLE), но не статусы ПОСЛЕ него:
 * WITHDRAWN (собственник забрал квартиру) и RESERVED (уже под задатком)
 * публиковались кнопкой и массово как обычный продаваемый объект. SOLD —
 * не сюда, это разрешённый случай (плашка «Продано» на сайте, см. sold в
 * siteSync.ts).
 */

const syncPropertiesToSite = vi.fn(async (properties: Array<{ id: string; shortId: number }>) => ({
  ok: true as const,
  results: properties.map((p) => ({ ok: true as const, externalId: p.id, shortId: p.shortId })),
}));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";
const phone = `+99294${runId.toString().slice(-7)}`;

let districtId: string;
let token: string;
let adminId: string;
const propertyIds: string[] = [];

async function seedProperty(status: "AVAILABLE" | "WITHDRAWN" | "RESERVED") {
  const property = await prisma.property.create({
    data: {
      title: `Bulk-sync-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      status,
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Bulk-sync-${runId}` } });
  districtId = district.id;
  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ bulk-sync",
      phone,
      role: "ADMIN",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  token = res.body.accessToken;
});

beforeEach(() => {
  syncPropertiesToSite.mockClear();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("bulk-sync: снятые с продажи и зарезервированные не публикуются", () => {
  it("WITHDRAWN → publish → 409, на сайт не уходит", async () => {
    const property = await seedProperty("WITHDRAWN");

    const res = await request(app)
      .post("/api/v1/properties/bulk-sync")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [property.id], action: "publish" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`№${property.shortId}`);
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
  });

  it("RESERVED → publish → 409, на сайт не уходит", async () => {
    const property = await seedProperty("RESERVED");

    const res = await request(app)
      .post("/api/v1/properties/bulk-sync")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [property.id], action: "publish" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`№${property.shortId}`);
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
  });

  it("AVAILABLE → publish → 200, публикация как обычно", async () => {
    const property = await seedProperty("AVAILABLE");

    const res = await request(app)
      .post("/api/v1/properties/bulk-sync")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [property.id], action: "publish" });

    expect(res.status).toBe(200);
    expect(syncPropertiesToSite).toHaveBeenCalled();
  });
});
