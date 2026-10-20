import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * SYNC-01 (аудит Codex, 04.10.2026): сайт отвечает HTTP 200, но по самому объекту
 * отказывает (`results: [{ ok: false }]`). `syncPropertiesToSite` в таком случае
 * возвращает `ok: true`, и разбор уведомления помечал объект опубликованным и закрывал
 * уведомление, хотя на сайте ничего не изменилось. Проверка элемента есть у всех
 * остальных вызывающих (propertyPipeline, trashProperty, crud...).
 */
const syncPropertiesToSite = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

describe("Разбор уведомления сайта: отказ по объекту при HTTP 200 не считается успехом", () => {
  const runId = Date.now();
  let districtId = "";
  let directorToken = "";
  const propertyIds: string[] = [];
  const notificationIds: string[] = [];

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("testpass123", 10);
    districtId = (await prisma.district.create({ data: { name: `Отказ-сайта-${runId}` } })).id;
    await prisma.agent.create({
      data: { fullName: "Директор отказа сайта", phone: `+992992${runId}`, role: "DIRECTOR", passwordHash },
    });
    const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992992${runId}`, password: "testpass123" });
    expect(res.status).toBe(200);
    directorToken = res.body.accessToken as string;
  });

  beforeEach(() => {
    syncPropertiesToSite.mockReset();
    // HTTP 200 от сайта, но объект сайт не принял.
    syncPropertiesToSite.mockResolvedValue({ ok: true, results: [{ externalId: "x", ok: false, error: "сайт отказал по объекту" }] });
  });

  afterAll(async () => {
    await prisma.siteEditNotification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { phone: `+992992${runId}` } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  async function seed(opts: { action: "CREATED" | "UPDATED"; status: "AVAILABLE" | "PENDING_REVIEW"; publishedOnSite: boolean }) {
    const property = await prisma.property.create({
      data: {
        title: `Объект отказа сайта ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 48,
        price: 50000,
        currency: "USD",
        districtId,
        address: `Тест отказа сайта ${runId}`,
        condition: "GOOD",
        status: opts.status,
        publishedOnSite: opts.publishedOnSite,
      },
    });
    propertyIds.push(property.id);
    const notification = await prisma.siteEditNotification.create({
      data: { propertyId: property.id, action: opts.action, changes: { price: 51000 } },
    });
    notificationIds.push(notification.id);
    return { property, notification };
  }

  async function resolve(notificationId: string, resolution: "ACCEPTED" | "REJECTED") {
    return request(app)
      .post(`/api/v1/site-notifications/${notificationId}/resolve`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ resolution });
  }

  const cases = [
    { name: "новый объект, принять (опубликовать)", action: "CREATED", resolution: "ACCEPTED", status: "AVAILABLE", published: false },
    { name: "новый объект, отклонить (скрыть)", action: "CREATED", resolution: "REJECTED", status: "AVAILABLE", published: true },
    { name: "правка, отклонить, объект не в продаже (снять с сайта)", action: "UPDATED", resolution: "REJECTED", status: "PENDING_REVIEW", published: true },
    { name: "правка, отклонить, объект в продаже (вернуть версию CRM)", action: "UPDATED", resolution: "REJECTED", status: "AVAILABLE", published: false },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: 502, публикация не меняется, захват снят`, async () => {
      const { property, notification } = await seed({ action: c.action, status: c.status, publishedOnSite: c.published });
      const res = await resolve(notification.id, c.resolution);
      expect(res.status).toBe(502);
      expect(String(res.body.error)).toContain("сайт отказал по объекту");

      const after = await prisma.property.findUnique({ where: { id: property.id } });
      expect(after?.publishedOnSite).toBe(c.published);
      const note = await prisma.siteEditNotification.findUnique({ where: { id: notification.id } });
      expect(note?.resolvedAt).toBeNull();
      expect(note?.resolution).toBeNull();
    });
  }
});
