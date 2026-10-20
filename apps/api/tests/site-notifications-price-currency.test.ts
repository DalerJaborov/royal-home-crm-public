import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЦЕНА С САЙТА — В СОМОНИ, ОБЪЕКТ — В СВОЕЙ ВАЛЮТЕ (ночная проверка 24.09.2026).
 *
 * Сайт royalhome.tj считает только в сомони: CRM шлёт туда `priceInTjs`
 * (lib/siteSync.ts), объекты с сайта заводятся с currency: "TJS" (webhooks.ts).
 * «Принять» правку цены с сайта (`routes/siteNotifications.ts`, UPDATED+ACCEPTED)
 * писало пришедшее число в `Property.price` как есть, не глядя на валюту объекта:
 * объект за 85 000 $ становился объектом за 935 000 $. Здесь: объект в долларах
 * получает цену, переведённую по курсу; объект в сомони — как есть; ноль не
 * принимается.
 */
describe("Принятие правки цены с сайта — валюта объекта", () => {
  const runId = Date.now();
  let districtId = "";
  let directorToken = "";
  let savedUsdToTjsRate: unknown = null;
  const propertyIds: string[] = [];
  const notificationIds: string[] = [];

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("testpass123", 10);
    districtId = (await prisma.district.create({ data: { name: `Валюта-сайта-${runId}` } })).id;
    await prisma.agent.create({
      data: { fullName: "Директор валюты сайта", phone: `+992991${runId}`, role: "DIRECTOR", passwordHash },
    });
    const directorRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ phone: `+992991${runId}`, password: "testpass123" });
    expect(directorRes.status).toBe(200);
    directorToken = directorRes.body.accessToken as string;

    // Курс фиксируем, чтобы ожидание в тесте было ровным числом (как в
    // property-price-sort.test.ts); в afterAll возвращаем прежний.
    const before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdToTjsRate: true } });
    savedUsdToTjsRate = before?.usdToTjsRate ?? null;
    await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: 11 } });
  });

  afterAll(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { usdToTjsRate: savedUsdToTjsRate as number | null },
    });
    await prisma.siteEditNotification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
    await prisma.agent.deleteMany({ where: { phone: `+992991${runId}` } });
    await prisma.district.deleteMany({ where: { id: districtId } });
  });

  async function seed(currency: "USD" | "TJS", price: number, sitePrice: unknown) {
    const property = await prisma.property.create({
      data: {
        title: `Объект цены сайта ${runId}-${propertyIds.length}`,
        type: "APARTMENT",
        areaSqm: 48,
        price,
        currency,
        districtId,
        address: `Тест цены сайта ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
        publishedOnSite: true,
      },
    });
    propertyIds.push(property.id);
    const notification = await prisma.siteEditNotification.create({
      data: { propertyId: property.id, action: "UPDATED", changes: { price: sitePrice } },
    });
    notificationIds.push(notification.id);
    return { property, notification };
  }

  async function accept(notificationId: string) {
    const res = await request(app)
      .post(`/api/v1/site-notifications/${notificationId}/resolve`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ resolution: "ACCEPTED" });
    expect(res.status).toBe(200);
  }

  it("объект в долларах: цена с сайта (сомони) переводится по курсу, а не пишется как есть", async () => {
    // На сайте объект за 85 000 $ стоит 935 000 с. (курс 11); сайт поднял до 990 000 с.
    const { property, notification } = await seed("USD", 85000, { from: 935000, to: 990000 });
    await accept(notification.id);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.currency).toBe("USD");
    expect(Number(after?.price)).toBe(90000);
  });

  it("объект в сомони: цена с сайта применяется как есть", async () => {
    const { property, notification } = await seed("TJS", 500000, 550000);
    await accept(notification.id);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(Number(after?.price)).toBe(550000);
  });

  it("ноль с сайта — не цена: объект остаётся при своей", async () => {
    const { property, notification } = await seed("TJS", 500000, 0);
    await accept(notification.id);
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(Number(after?.price)).toBe(500000);
  });
});
