import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildMarketingFunnel } from "../src/lib/marketingFunnel.js";
import { dushanbeStartOfMonth } from "../src/lib/dushanbeTime.js";

/**
 * Воронка маркетинга режет месяц по Душанбе, а не по UTC (глубокая проверка
 * 02.10.2026, C8). Раньше месяц начинался в 05:00 1-го по Душанбе: ночные лиды
 * 1-го числа не попадали ни в этот, ни в прошлый месяц, а с 00:00 до 05:00 1-го
 * пульт показывал по всем каналам ноль. Показы — без отменённых и без клиентов
 * из Корзины, как в «Отчётах».
 */

const runId = Date.now();
const SOURCE = "WALK_IN" as const;
let agentId = "";
let districtId = "";
let propertyId = "";
const clientIds: string[] = [];

// 1-е число текущего месяца, 01:00 по Душанбе — «ночь первого».
const monthStart = dushanbeStartOfMonth(new Date());
const now = new Date(monthStart.getTime() + 60 * 60_000);
const nightLead = new Date(monthStart.getTime() + 30 * 60_000);

async function channel() {
  const res = await buildMarketingFunnel(false, now);
  const c = res.channels.find((x) => x.source === SOURCE);
  return { leads: c?.leadsMonth ?? 0, showings: c?.showingsMonth ?? 0 };
}

async function makeClient(deleted = false) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент воронка ${runId}-${clientIds.length}`,
      phone: `+992944${clientIds.length}${runId}`,
      source: SOURCE,
      createdAt: nightLead,
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент воронка ${runId}`, phone: `+992943${runId}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район воронка ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект воронка ${runId}`, type: "APARTMENT", areaSqm: 40, price: 1000, currency: "TJS", districtId, address: "Тестовая", condition: "GOOD" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("C8: воронка маркетинга — месяц по Душанбе", () => {
  it("ночной лид 1-го числа в счёт месяца; отменённый показ и показ клиента из Корзины — нет", async () => {
    const before = await channel();

    const live = await makeClient();
    const trashed = await makeClient(true);
    const showing = { propertyId, agentId, type: "SHOWING" as const, notes: "Показ", createdAt: nightLead };
    await prisma.interaction.create({ data: { ...showing, clientId: live.id, completedAt: nightLead } });
    // Отменённый показ: решение «не состоялся», следующего шага нет.
    await prisma.interaction.create({ data: { ...showing, clientId: live.id, declinedAt: nightLead, nextAction: null } });
    await prisma.interaction.create({ data: { ...showing, clientId: trashed.id, completedAt: nightLead } });

    const after = await channel();
    expect(after.leads - before.leads).toBe(1);
    expect(after.showings - before.showings).toBe(1);
  });
});
