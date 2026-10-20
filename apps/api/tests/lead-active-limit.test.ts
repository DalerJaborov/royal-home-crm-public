import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { pickAgentForLead } from "../src/leads.js";

/** «Лимит 5»: агент с полным портфелем активных лидов новых не получает;
 *  если на лимите все — лимит уступает, клиент без агента хуже. */

const runId = Date.now();

let fullAgentId: string;
let freeAgentId: string;
const clientIds: string[] = [];
let savedLimit: number | null = null;

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  savedLimit = settings?.leadActiveLimit ?? null;
  // Лимит 2 вместо 5 — тесту хватает двух клиентов, чтобы «заполнить» агента.
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadActiveLimit: 2 } });

  const full = await prisma.agent.create({
    data: { fullName: "Агент заполненный", phone: `+992977${runId}`, role: "AGENT", passwordHash: "x" },
  });
  fullAgentId = full.id;
  const free = await prisma.agent.create({
    data: { fullName: "Агент свободный", phone: `+992976${runId}`, role: "AGENT", passwordHash: "x" },
  });
  freeAgentId = free.id;

  for (let i = 0; i < 2; i++) {
    const c = await prisma.client.create({
      data: {
        fullName: `Лид лимита ${i} ${runId}`,
        phone: `+99296${i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: fullAgentId,
        acceptedAt: new Date(),
        status: i === 0 ? "NEW" : "HOT",
      },
    });
    clientIds.push(c.id);
  }
});

afterAll(async () => {
  if (savedLimit !== null) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadActiveLimit: savedLimit } });
  }
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [fullAgentId, freeAgentId] } } });
  await prisma.$disconnect();
});

describe("Лимит активных лидов", () => {
  it("заполненный агент новых лидов не получает", async () => {
    // Исключаем всех, кроме пары из этого теста, — в базе есть агенты сидов.
    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [fullAgentId, freeAgentId] } },
      select: { id: true },
    });
    for (let i = 0; i < 5; i++) {
      const picked = await pickAgentForLead(others.map((a) => a.id));
      expect(picked).toBe(freeAgentId);
    }
  });

  it("если на лимите все — лимит уступает, лид всё равно назначается", async () => {
    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { not: fullAgentId } },
      select: { id: true },
    });
    const picked = await pickAgentForLead(others.map((a) => a.id));
    expect(picked).toBe(fullAgentId);
  });

  /**
   * ЛИМИТ — ТОЛЬКО НА ПОКУПАТЕЛЕЙ (владелец 20.08.2026: «лимита нет на продавцов,
   * кто-то продаёт квартиру — такие лиды должны без лимита приходить»).
   *
   * Два конца одного правила, и оба проверяются здесь: продавец сам НЕ занимает
   * слот (иначе он молча вытеснил бы покупателя из портфеля) и НЕ упирается в
   * заполненный портфель при раздаче (иначе агентство теряло бы объект из-за
   * того, что у агента много покупателей).
   */
  it("продавец не занимает слот и приходит даже при полном портфеле", async () => {
    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [fullAgentId, freeAgentId] } },
      select: { id: true },
    });
    const exclude = others.map((a) => a.id);

    // Продавец идёт по обычной очереди, лимит его не фильтрует: заполненный агент
    // остаётся кандидатом наравне со свободным.
    const seller = await prisma.client.create({
      data: {
        fullName: `Продавец без лимита ${runId}`,
        phone: `+992955${runId}`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: fullAgentId,
        acceptedAt: new Date(),
        status: "NEW",
      },
    });
    clientIds.push(seller.id);

    // Покупатель по-прежнему обходит заполненного — продавец в портфеле счёт не поднял.
    expect(await pickAgentForLead(exclude, "BUYER")).toBe(freeAgentId);

    // А заполнить портфель заполненного агента продавцами и подавно нельзя:
    // при раздаче продавца лимит не применяется вовсе, кандидаты — оба агента.
    const pickedForSeller = await pickAgentForLead([...exclude, freeAgentId], "SELLER");
    expect(pickedForSeller).toBe(fullAgentId);
  });
});
