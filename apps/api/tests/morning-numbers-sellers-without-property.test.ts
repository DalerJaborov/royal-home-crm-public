import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { countSellersWithoutPropertyOver7Days } from "../src/lib/morningNumbers.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";

/**
 * «Утренние цифры»: продавцов без объекта 7+ дней (ночная проверка 24.09.2026).
 *
 * Найдено разбором: `countSellersWithoutPropertyOver7Days` (lib/morningNumbers.ts)
 * искал объекты продавца без фильтра `deletedAt: null` — продавец, чей
 * единственный объект уже в Корзине, засчитывался как «объект есть» и не
 * попадал в счётчик. Зеркальная тревога `sellerNoPropertyAlarm.ts` этот
 * фильтр уже ставит — здесь его не было.
 *
 * Проверяем не абсолютное число (в базе могут быть и другие продавцы), а
 * разницу: у СВОЕГО продавца объект появляется и сразу же уходит в Корзину —
 * счётчик обязан вернуться к тому же значению, что и до появления объекта.
 */

const runId = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let districtId: string;
let agentId: string;
let sellerId: string;
let propertyId: string | null = null;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-утро-без-объекта-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент утренних цифр", phone: `+9928${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Продавец без объекта ${runId}`,
        phone: `+9927${String(runId).slice(-8)}`,
        source: "WALK_IN",
        kind: "SELLER",
        assignedAgentId: agentId,
        // Заведён давно, чтобы наверняка попасть за порог в 7 дней.
        createdAt: new Date(Date.now() - 30 * DAY),
      },
    })
  ).id;
});

afterAll(async () => {
  if (propertyId) await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: sellerId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("countSellersWithoutPropertyOver7Days", () => {
  it("объект удалён в Корзину — продавец снова считается «без объекта»", async () => {
    const startOfToday = dushanbeStartOfToday();

    const withoutProperty = await countSellersWithoutPropertyOver7Days(startOfToday);

    const property = await prisma.property.create({
      data: {
        title: `Объект без покупателя ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 45000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: sellerId,
      },
    });
    propertyId = property.id;

    const withProperty = await countSellersWithoutPropertyOver7Days(startOfToday);
    expect(withProperty).toBe(withoutProperty - 1);

    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date() } });

    const afterTrash = await countSellersWithoutPropertyOver7Days(startOfToday);
    expect(afterTrash).toBe(withoutProperty);
  });
});
