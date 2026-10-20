import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { releaseInterruptedSiteEditClaims } from "../src/routes/siteNotifications.js";

/**
 * ПРАВКА С САЙТА, ЧЕЙ РАЗБОР ОБОРВАЛ РЕСТАРТ (21.09.2026).
 *
 * Разбор уведомления ходит на сайт — это секунды сетевого вызова, и захват
 * берётся ДО него, иначе двойной клик отправил бы на сайт две противоречащие
 * команды. Но снимал захват только тот же самый запрос, а автовыкат
 * перезапускает контейнеры по каждому мержу в main. Рестарт посреди синка
 * оставлял уведомление с отметкой «разобрано» навсегда, при том что на сайт не
 * ушло ничего: список «на разбор» фильтруется по `resolvedAt`, и правка просто
 * пропадала с глаз — без ошибки и без следа.
 *
 * Стерегут тесты ровно две вещи: недоделанный разбор возвращается в список, а
 * доделанный остаётся доделанным.
 */

const runId = Date.now();
let propertyId = "";
let districtId = "";
const createdNotificationIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Разбор-район-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект разбора ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 55000,
        currency: "USD",
        districtId,
        address: `Тест разбора ${runId}`,
        condition: "GOOD",
        status: "AVAILABLE",
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.siteEditNotification.deleteMany({ where: { id: { in: createdNotificationIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function seedNotification(data: { resolution?: string | null; resolvedAt?: Date | null }): Promise<string> {
  const notification = await prisma.siteEditNotification.create({
    data: {
      propertyId,
      action: "UPDATED",
      changes: { price: 60000 },
      resolution: data.resolution ?? null,
      resolvedAt: data.resolvedAt ?? null,
    },
  });
  createdNotificationIds.push(notification.id);
  return notification.id;
}

describe("Разбор правки с сайта переживает рестарт процесса", () => {
  it("оборванный захват снимается на старте — правку снова можно разобрать", async () => {
    // «Разбор начат и не закончен»: решение записано, отметки об окончании нет.
    const id = await seedNotification({ resolution: "ACCEPTED", resolvedAt: null });

    const released = await releaseInterruptedSiteEditClaims();
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.siteEditNotification.findUnique({ where: { id } });
    // Захват свободен: повторный «Принять» больше не упрётся в 409.
    expect(after?.resolution).toBeNull();
    // И всё это время правка оставалась в списке «на разбор».
    expect(after?.resolvedAt).toBeNull();
  });

  it("законченный разбор не трогается", async () => {
    const id = await seedNotification({ resolution: "REJECTED", resolvedAt: new Date() });

    await releaseInterruptedSiteEditClaims();

    const after = await prisma.siteEditNotification.findUnique({ where: { id } });
    expect(after?.resolution).toBe("REJECTED");
    expect(after?.resolvedAt).not.toBeNull();
  });

  it("неразобранная правка остаётся неразобранной", async () => {
    const id = await seedNotification({});

    await releaseInterruptedSiteEditClaims();

    const after = await prisma.siteEditNotification.findUnique({ where: { id } });
    expect(after?.resolution).toBeNull();
    expect(after?.resolvedAt).toBeNull();
  });
});
