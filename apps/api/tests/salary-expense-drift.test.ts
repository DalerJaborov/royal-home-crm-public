import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { upsertSalaryExpenses } from "../src/lib/financeAutomation.js";
import { dushanbeWallClock, DUSHANBE_OFFSET_MS } from "../src/lib/dushanbeTime.js";

/**
 * Зарплатная строка не должна плыть вслед за курсом (аудит №4, 27.08).
 *
 * upsertSalaryExpenses гоняется каждую ночь, через 20 минут после обновления
 * курса с alif.tj. Раньше долларовые доли конвертировались заново, и «зарплата
 * июля» месяц ездила туда-сюда; ручную правку директора крон откатывал.
 */

const runId = Date.now();
let agentId = "";
let clientId = "";
let propertyId = "";
let districtId = "";
let dealId = "";
const month = (() => {
  const wall = dushanbeWallClock();
  const prev = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
})();
const autoKey = () => `salary:${agentId}:${month}`;

/** Курс USD→TJS в настройках — им управляет тест, имитируя ночное обновление. */
async function setRate(rate: number): Promise<void> {
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: rate } });
}

/** Курс до правок — возвращается в afterAll: Settings один на всю базу. */
let savedUsdToTjsRate = 0;

beforeAll(async () => {
  const beforeSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { usdToTjsRate: true },
  });
  savedUsdToTjsRate = beforeSettings.usdToTjsRate;
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент зарплаты ${runId}`, phone: `+992955${String(runId).slice(-6)}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район зарплаты ${runId}`, city: "Душанбе" } })).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент зарплаты ${runId}`, phone: `+992956${String(runId).slice(-6)}`, source: "WALK_IN" },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект зарплаты ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 100000,
        currency: "USD",
        districtId,
        address: "Тестовая зарплатная, 1",
        condition: "GOOD",
        status: "SOLD",
        createdById: agentId,
      },
    })
  ).id;
  // Сделка прошлого месяца в ДОЛЛАРАХ — именно её доля пересчитывалась по курсу.
  const wall = dushanbeWallClock();
  const closedAt = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 15, 12, 0) - DUSHANBE_OFFSET_MS);
  dealId = (
    await prisma.deal.create({
      data: {
        clientId,
        propertyId,
        agentId,
        stage: "COMPLETED",
        currency: "USD",
        soldPrice: 100000,
        commissionRealtorAmount: 1000,
        closedAt,
      },
    })
  ).id;
});

beforeEach(async () => {
  await prisma.expense.deleteMany({ where: { autoKey: autoKey() } });
  await setRate(10);
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { autoKey: autoKey() } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  // Курс — общая настройка: оставленный тестовый курс уводил бы суммы в соседних
  // файлах (финансы, отчёты, сортировка объектов по цене).
  await prisma.settings.update({ where: { id: "singleton" }, data: { usdToTjsRate: savedUsdToTjsRate } });
  await prisma.$disconnect();
});

describe("зарплатная строка за прошлый месяц", () => {
  it("создаётся один раз и НЕ пересчитывается, когда сдвинулся только курс", async () => {
    await upsertSalaryExpenses();
    const created = await prisma.expense.findUnique({ where: { autoKey: autoKey() } });
    expect(created).not.toBeNull();
    const firstAmount = Number(created!.amount);
    expect(firstAmount).toBeGreaterThan(0);
    expect(created!.autoFingerprint).toContain("USD:1000");

    // Ночь: курс уехал, состав сделок тот же.
    await setRate(11);
    await upsertSalaryExpenses();

    const after = await prisma.expense.findUniqueOrThrow({ where: { autoKey: autoKey() } });
    expect(Number(after.amount)).toBe(firstAmount);
  });

  it("пересчитывается, когда изменился состав долей", async () => {
    await upsertSalaryExpenses();
    const before = await prisma.expense.findUniqueOrThrow({ where: { autoKey: autoKey() } });

    // Комиссию поправили в сделке — это и есть законный повод пересчитать.
    await prisma.deal.update({ where: { id: dealId }, data: { commissionRealtorAmount: 1500 } });
    await upsertSalaryExpenses();

    const after = await prisma.expense.findUniqueOrThrow({ where: { autoKey: autoKey() } });
    expect(Number(after.amount)).toBeGreaterThan(Number(before.amount));
    expect(after.autoFingerprint).toContain("USD:1500");

    await prisma.deal.update({ where: { id: dealId }, data: { commissionRealtorAmount: 1000 } });
  });

  it("ручную правку директора автоматика не откатывает", async () => {
    await upsertSalaryExpenses();
    const row = await prisma.expense.findUniqueOrThrow({ where: { autoKey: autoKey() } });
    // Директор поправил сумму руками (PATCH ставит manualEditedAt).
    await prisma.expense.update({ where: { id: row.id }, data: { amount: 12345, manualEditedAt: new Date() } });

    // Даже при изменившемся составе долей.
    await prisma.deal.update({ where: { id: dealId }, data: { commissionRealtorAmount: 2000 } });
    await upsertSalaryExpenses();

    const after = await prisma.expense.findUniqueOrThrow({ where: { autoKey: autoKey() } });
    expect(Number(after.amount)).toBe(12345);

    await prisma.deal.update({ where: { id: dealId }, data: { commissionRealtorAmount: 1000 } });
  });
});
