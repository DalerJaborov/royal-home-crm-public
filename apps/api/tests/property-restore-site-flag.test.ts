import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * ВОССТАНОВЛЕННЫЙ ИЗ КОРЗИНЫ ОБЪЕКТ НЕ ЧИСЛИТСЯ ОПУБЛИКОВАННЫМ (ночная проверка
 * 24.09.2026, №128).
 *
 * trashProperties снимает объявление с сайта (unpublishBeforeTrash), но
 * намеренно не трогает publishedOnSite — по замыслу решение о повторной
 * публикации принимают отдельно кнопкой. Restore тоже не трогал этот флаг —
 * в итоге объект выходил из Корзины с publishedOnSite: true, хотя на сайте
 * объявления уже нет: кнопка на карточке показывала «Снять с публикации», а
 * первая же правка карточки (PATCH) видела publishedOnSite: true и молча
 * ставила задание на досылку объекта на сайт (resyncPhotosIfPublished) — тот
 * же довод, что у сброса флага при WITHDRAWN (routes/properties/crud.ts).
 */

const syncPropertiesToSite = vi.fn(async () => ({ ok: true as const, results: [{ ok: true as const, shortId: 1 }] }));
const resyncPhotosIfPublished = vi.fn(async () => {});
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
  resyncPhotosIfPublished,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const password = "testpass123";
const phone = `+99293${runId.toString().slice(-7)}`;

let districtId: string;
let token: string;
let adminId: string;
const propertyIds: string[] = [];

async function seedPublished() {
  const property = await prisma.property.create({
    data: {
      title: `Корзина-сайт-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 350000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 8",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
    },
  });
  propertyIds.push(property.id);
  return property;
}

beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: `Корзина-сайт-${runId}` } });
  districtId = district.id;
  const admin = await prisma.agent.create({
    data: {
      fullName: "Админ восстановления сайта",
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
  resyncPhotosIfPublished.mockClear();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Восстановление из Корзины сбрасывает отметку о публикации", () => {
  it("Корзина → Восстановить → publishedOnSite === false, PATCH не досылает на сайт", async () => {
    const property = await seedPublished();

    const trashRes = await request(app)
      .delete(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(trashRes.status).toBe(204);

    const restoreRes = await request(app)
      .post(`/api/v1/properties/${property.id}/restore`)
      .set("Authorization", `Bearer ${token}`);
    expect(restoreRes.status).toBe(204);

    const afterRestore = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(afterRestore.deletedAt).toBeNull();
    expect(afterRestore.publishedOnSite).toBe(false);

    // Правка описания после восстановления не должна считать объект
    // опубликованным и посылать его обратно на сайт.
    const patchRes = await request(app)
      .patch(`/api/v1/properties/${property.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: `Корзина-сайт-после-восстановления-${runId}` });
    expect(patchRes.status).toBe(200);
    expect(resyncPhotosIfPublished).not.toHaveBeenCalled();

    const afterPatch = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(afterPatch.publishedOnSite).toBe(false);
  });
});
