import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * Рубильник для теста на атомарность ниже: ронять отзыв публичных ссылок,
 * который идёт ВНУТРИ транзакции принятия удаления объекта сайтом
 * (`routes/siteNotifications.ts`, ветка DELETED+ACCEPTED). Подмена ДОПОЛНЯЕТ
 * модуль, а не заменяет его целиком (см. CLAUDE.md — забытый экспорт валит
 * прогон в другом файле).
 */
let mockFailRevokeOnce = false;
vi.mock("../src/lib/propertyShareLink.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/propertyShareLink.js")>();
  return {
    ...actual,
    revokePropertyShareLinks: (...args: Parameters<typeof actual.revokePropertyShareLinks>) => {
      if (mockFailRevokeOnce) {
        mockFailRevokeOnce = false;
        throw new Error("тестовое падение посреди транзакции удаления объекта");
      }
      return actual.revokePropertyShareLinks(...args);
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

/**
 * УДАЛЕНИЕ ОБЪЕКТА САЙТОМ — ОДНА ТРАНЗАКЦИЯ НА ВСЕХ СПУТНИКОВ (22.09.2026).
 *
 * `property.update({deletedAt})`, закрытие заявки агента на удаление и отзыв
 * публичных ссылок на просмотр раньше шли порознь: падение между ними
 * оставляло объект в Корзине с ОТКРЫТОЙ заявкой на удаление и ЖИВЫМИ приватными
 * ссылками — тот самый класс «спутник не гаснет при удалении родителя».
 */
describe("Принятие удаления объекта сайтом — атомарность", () => {
  const runId = Date.now();
  let districtId = "";
  let agentId = "";
  let directorToken = "";
  const propertyIds: string[] = [];
  const notificationIds: string[] = [];
  const deleteRequestIds: string[] = [];
  const shareLinkIds: string[] = [];

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("testpass123", 10);
    districtId = (await prisma.district.create({ data: { name: `Разбор-удаление-${runId}` } })).id;
    agentId = (
      await prisma.agent.create({
        data: { fullName: "Агент разбора удаления", phone: `+992989${runId}`, role: "AGENT", passwordHash },
      })
    ).id;
    const directorId = (
      await prisma.agent.create({
        data: { fullName: "Директор разбора удаления", phone: `+992990${runId}`, role: "DIRECTOR", passwordHash },
      })
    ).id;
    const directorRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: `+992990${runId}`, password: "testpass123" });
    expect(directorRes.status).toBe(200);
    directorToken = directorRes.body.accessToken as string;
    void directorId;
  });

  afterAll(async () => {
    await prisma.propertyShareLink.deleteMany({ where: { id: { in: shareLinkIds } } });
    await prisma.propertyDeleteRequest.deleteMany({ where: { id: { in: deleteRequestIds } } });
    await prisma.siteEditNotification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { phone: { in: [`+992989${runId}`, `+992990${runId}`] } } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  async function seedScenario() {
    const property = await prisma.property.create({
      data: {
        title: `Объект удаления сайтом ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 48,
        price: 42000,
        currency: "USD",
        districtId,
        address: `Тест удаления сайтом ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        publishedOnSite: true,
      },
    });
    propertyIds.push(property.id);

    const deleteRequest = await prisma.propertyDeleteRequest.create({
      data: {
        propertyId: property.id,
        requestedById: agentId,
        reason: "SOLD_ELSEWHERE",
        status: "PENDING",
      },
    });
    deleteRequestIds.push(deleteRequest.id);

    const shareLink = await prisma.propertyShareLink.create({
      data: {
        propertyId: property.id,
        token: `share-${runId}-${propertyIds.length}-${Math.random().toString(36).slice(2)}`,
        createdByAgentId: agentId,
      },
    });
    shareLinkIds.push(shareLink.id);

    const notification = await prisma.siteEditNotification.create({
      data: { propertyId: property.id, action: "DELETED" },
    });
    notificationIds.push(notification.id);

    return { property, deleteRequest, shareLink, notification };
  }

  it("падение при отзыве ссылок откатывает и мягкое удаление объекта", async () => {
    const { property, deleteRequest, shareLink, notification } = await seedScenario();

    mockFailRevokeOnce = true;
    try {
      const res = await request(app)
        .post(`/api/v1/site-notifications/${notification.id}/resolve`)
        .set("Authorization", `Bearer ${directorToken}`)
        .send({ resolution: "ACCEPTED" });
      expect(res.status).toBe(500);
    } finally {
      mockFailRevokeOnce = false;
    }

    // БЕЗ атомарности объект уже был бы в Корзине здесь — с транзакцией откат
    // возвращает property.update тоже.
    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.deletedAt).toBeNull();
    expect(propertyAfter?.publishedOnSite).toBe(true);

    const deleteRequestAfter = await prisma.propertyDeleteRequest.findUnique({ where: { id: deleteRequest.id } });
    expect(deleteRequestAfter?.status).toBe("PENDING");

    const shareLinkAfter = await prisma.propertyShareLink.findUnique({ where: { id: shareLink.id } });
    expect(shareLinkAfter?.revokedAt).toBeNull();

    // Отказ снимает захват — уведомление остаётся разбираемым, а не зависает.
    const notificationAfter = await prisma.siteEditNotification.findUnique({ where: { id: notification.id } });
    expect(notificationAfter?.resolvedAt).toBeNull();
    expect(notificationAfter?.resolution).toBeNull();
  });

  it("без падения все три спутника гаснут вместе", async () => {
    const { property, deleteRequest, shareLink, notification } = await seedScenario();

    const res = await request(app)
      .post(`/api/v1/site-notifications/${notification.id}/resolve`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ resolution: "ACCEPTED" });
    expect(res.status).toBe(200);

    const propertyAfter = await prisma.property.findUnique({ where: { id: property.id } });
    expect(propertyAfter?.deletedAt).not.toBeNull();
    expect(propertyAfter?.publishedOnSite).toBe(false);

    const deleteRequestAfter = await prisma.propertyDeleteRequest.findUnique({ where: { id: deleteRequest.id } });
    expect(deleteRequestAfter?.status).toBe("APPROVED");

    const shareLinkAfter = await prisma.propertyShareLink.findUnique({ where: { id: shareLink.id } });
    expect(shareLinkAfter?.revokedAt).not.toBeNull();

    const notificationAfter = await prisma.siteEditNotification.findUnique({ where: { id: notification.id } });
    expect(notificationAfter?.resolvedAt).not.toBeNull();
    expect(notificationAfter?.resolution).toBe("ACCEPTED");
  });
});
