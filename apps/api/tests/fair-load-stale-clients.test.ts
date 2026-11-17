import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ЖИВАЯ НАГРУЗКА В ЧЕСТНОЙ РАЗДАЧЕ (владелец 16.11.2026). «Неактивных»,
 * «Отложенных» и «Потерянных» больше нет — старые покупатели опытного агента
 * вернулись в «в работе». Если считать нагрузку по ним, новичок с нулём получал
 * бы КАЖДУЮ заявку. Нагрузка — только покупатели с настоящим контактом за 30
 * дней, сделкой в работе или свежей заявкой (lib/agentLoad.ts).
 */

const { prisma } = await import("../src/db.js");
const { pickAgentForLead } = await import("../src/leads.js");

const runId = Date.now().toString().slice(-7);
const DAY = 24 * 3_600_000;
let veteranId: string;
let newcomerId: string;
const clientIds: string[] = [];
let savedStrategy: string | null = null;

beforeAll(async () => {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedStrategy = s.leadDistributionStrategy;
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
  const mk = async (name: string, n: number) =>
    (
      await prisma.agent.create({
        data: { fullName: `${name} ${runId}`, phone: `+99293${runId}${n}`, role: "AGENT", passwordHash: "x", lastSeenAt: new Date() },
      })
    ).id;
  veteranId = await mk("Опытный", 1);
  newcomerId = await mk("Новичок", 2);
  // 80 давно молчащих покупателей опытного агента: ни разговора, ни сообщения, назначены полгода назад.
  const old = new Date(Date.now() - 200 * DAY);
  await prisma.client.createMany({
    data: Array.from({ length: 80 }, (_, i) => ({
      fullName: `Старый ${runId}-${i}`,
      phone: `+99293${runId}${String(i).padStart(3, "0")}`,
      source: "PHONE_CALL" as const,
      kind: "BUYER" as const,
      status: "CONTACTED" as const,
      assignedAgentId: veteranId,
      acceptedAt: old,
      assignedAt: old,
      createdAt: old,
      firstContactAt: old,
      lastContactAt: old,
    })),
  });
  clientIds.push(...(await prisma.client.findMany({ where: { assignedAgentId: veteranId }, select: { id: true } })).map((c) => c.id));
});

afterAll(async () => {
  if (savedStrategy) await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy as never } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [veteranId, newcomerId] } } });
});

describe("честная раздача: старые молчащие карточки — не нагрузка", () => {
  it("опытный с 80 давно молчащими клиентами и новичок получают заявки по очереди, а не всё новичку", async () => {
    const others = (await prisma.agent.findMany({ where: { id: { notIn: [veteranId, newcomerId] } }, select: { id: true } })).map((a) => a.id);
    const got: string[] = [];
    for (let i = 0; i < 6; i++) {
      const picked = await pickAgentForLead(others, "BUYER");
      expect([veteranId, newcomerId]).toContain(picked);
      got.push(picked!);
      // Заявка досталась — она теперь живая нагрузка выбранного агента.
      const c = await prisma.client.create({
        data: { fullName: `Новая ${runId}-${i}`, phone: `+99293${runId}9${i}`, source: "PHONE_CALL", kind: "BUYER", status: "NEW", assignedAgentId: picked },
      });
      clientIds.push(c.id);
    }
    const toVeteran = got.filter((id) => id === veteranId).length;
    expect(toVeteran).toBe(3);
    // Подряд одному и тому же — не больше одной заявки.
    for (let i = 1; i < got.length; i++) expect(got[i]).not.toBe(got[i - 1]);
  });
});
