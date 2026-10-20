import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const { prisma } = await import("../src/db.js");
const { upsertSalaryExpenses } = await import("../src/lib/financeAutomation.js");
const { annulDeal } = await import("../src/lib/dealAnnul.js");
const { dealSalaryAutoKey } = await import("../src/lib/companyProfit.js");
const { DUSHANBE_OFFSET_MS } = await import("../src/lib/dushanbeTime.js");

/**
 * АННУЛИРОВАНИЕ ЗАКРЫТОЙ СДЕЛКИ ОБНУЛЯЕТ АВТО-ЗАРПЛАТУ АГЕНТА (аудит Codex 04.10.2026, №7).
 *
 * annulDeal ставит CANCELLED и зовёт upsertSalaryExpenses(месяц закрытия), но
 * функция строила byAgent только из COMPLETED-сделок месяца: у агента без
 * живых закрытых сделок его строки там не было, и «причитается» от
 * аннулированной сделки висело вечно (ночной тик смотрит лишь прошлый месяц).
 *
 * БД общая на все файлы, upsertSalaryExpenses сканирует месяц целиком, поэтому
 * все проверки только по своим строкам (свои агенты и autoKey). Месяц взят
 * далёкий и свой, чтобы не пересекаться с другими файлами.
 */

const runId = Date.now();
const MONTH = "2021-03";
const monthStart = new Date(Date.UTC(2021, 2, 1) - DUSHANBE_OFFSET_MS);
const closedAt = new Date(monthStart.getTime() + 5 * 24 * 60 * 60 * 1000);

let districtId: string;
let directorId: string;
let agentA: string;
let agentB: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClosedDeal(agentId: string, realtorShare: number) {
  const n = dealIds.length;
  const property = await prisma.property.create({
    data: {
      title: `Объект зарплата-аннулирование ${runId}-${n}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, зарплата",
      condition: "GOOD",
      status: "SOLD",
      soldAt: closedAt,
      soldPrice: 100000,
      assignedAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент зарплата-аннулирование ${runId}-${n}`,
      phone: `+99296${n}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      status: "DEAL_CLOSED",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(client.id);
  const deal = await prisma.deal.create({
    data: {
      clientId: client.id,
      propertyId: property.id,
      agentId,
      stage: "COMPLETED",
      soldPrice: 100000,
      commissionAmount: realtorShare * 2,
      commissionRealtorAmount: realtorShare,
      commissionCompanyAmount: realtorShare,
      commissionIntakeAmount: 0,
      closedAt,
    },
  });
  dealIds.push(deal.id);
  return deal;
}

async function salaryOf(agentId: string) {
  return prisma.expense.findUnique({ where: { autoKey: dealSalaryAutoKey(agentId, MONTH) } });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-зарплата-аннулирование-${runId}` } })).id;
  const mk = async (name: string, phone: string, role: "DIRECTOR" | "AGENT") =>
    (await prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone, role, passwordHash: "x" } })).id;
  directorId = await mk("Директор зарплата-аннулирование", `+99297${runId}1`, "DIRECTOR");
  agentA = await mk("Агент А зарплата-аннулирование", `+99297${runId}2`, "AGENT");
  agentB = await mk("Агент Б зарплата-аннулирование", `+99297${runId}3`, "AGENT");
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces([directorId, agentA, agentB]);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("upsertSalaryExpenses после аннулирования сделки", () => {
  it("единственная закрытая сделка агента аннулирована: строка 5000 становится 0", async () => {
    const deal = await makeClosedDeal(agentA, 5000);
    await upsertSalaryExpenses(MONTH);
    expect(Number((await salaryOf(agentA))!.amount)).toBe(5000);

    // annulDeal сам зовёт upsertSalaryExpenses(месяц закрытия)
    await annulDeal({ dealId: deal.id, actorId: directorId, reason: "Тест обнуления зарплаты" });

    const row = await salaryOf(agentA);
    expect(Number(row!.amount)).toBe(0);
    expect(row!.deletedAt).toBeNull();
  });

  it("у другого агента сделки остались: его строка не тронута, у этого обнулена", async () => {
    // agentA: строка из прошлого теста уже 0 и manualEditedAt null — чистим, чтобы тест был независим
    await prisma.expense.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
    const dealA = await makeClosedDeal(agentA, 3000);
    await makeClosedDeal(agentB, 4000);
    await upsertSalaryExpenses(MONTH);
    expect(Number((await salaryOf(agentA))!.amount)).toBe(3000);
    expect(Number((await salaryOf(agentB))!.amount)).toBe(4000);

    await annulDeal({ dealId: dealA.id, actorId: directorId, reason: "Тест обнуления, у другого остались" });

    expect(Number((await salaryOf(agentA))!.amount)).toBe(0);
    expect(Number((await salaryOf(agentB))!.amount)).toBe(4000);
  });

  it("ручная правка директора не обнуляется", async () => {
    await prisma.expense.deleteMany({ where: { agentId: { in: [agentA, agentB] } } });
    const deal = await makeClosedDeal(agentA, 2500);
    await upsertSalaryExpenses(MONTH);
    await prisma.expense.update({
      where: { autoKey: dealSalaryAutoKey(agentA, MONTH) },
      data: { amount: 777, manualEditedAt: new Date() },
    });

    await annulDeal({ dealId: deal.id, actorId: directorId, reason: "Тест: ручная правка остаётся" });

    expect(Number((await salaryOf(agentA))!.amount)).toBe(777);
  });
});
