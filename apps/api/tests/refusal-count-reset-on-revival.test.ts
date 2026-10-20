import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * refusalCount сбрасывается не только на закрытой сделке (routes/deals.ts),
 * но и когда клиент, ранее LOST/Неактивный, возвращается САМ — написал/
 * позвонил, без новой сделки (services/leads/intake.ts, найдено 01.09.2026).
 * Без сброса карточка навсегда несла старые отказы, и следующая сделка снова
 * получала бы отказной сплит 70/30, хотя к новому заходу давние отказы
 * отношения не имеют.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
const password = "testpass123";
let agentId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент возврата отказов", phone: `+992${runId}70`, role: "AGENT", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("intake.ts — сброс refusalCount при самостоятельном возврате", () => {
  it("клиент был LOST с отказами — сам написал снова, refusalCount сбрасывается в 0", async () => {
    const phone = `+992${runId}71`;
    const first = await createLeadFromChannel({ fullName: "Потерянный с отказами", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { status: "LOST", lostAt: new Date(), refusalCount: 3, assignedAgentId: agentId },
    });

    await createLeadFromChannel({ fullName: "Потерянный с отказами", phone, source: "WHATSAPP", kind: "BUYER" });

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(after?.status).toBe("NEW");
    expect(after?.refusalCount).toBe(0);
  });

  it("клиент был Неактивным (workStatus=INACTIVE) с отказами — сам написал, refusalCount сбрасывается", async () => {
    const phone = `+992${runId}72`;
    const first = await createLeadFromChannel({ fullName: "Неактивный с отказами", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { workStatus: "INACTIVE", refusalCount: 2, assignedAgentId: agentId, lastAgentId: agentId },
    });

    await createLeadFromChannel({ fullName: "Неактивный с отказами", phone, source: "WHATSAPP", kind: "BUYER" });

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    expect(after?.refusalCount).toBe(0);
  });

  it("обычный АКТИВНЫЙ клиент с отказами пишет снова — refusalCount НЕ трогается", async () => {
    const phone = `+992${runId}73`;
    const first = await createLeadFromChannel({ fullName: "Активный с отказами", phone, source: "INSTAGRAM", kind: "BUYER" });
    clientIds.push(first.clientId);
    await prisma.client.update({
      where: { id: first.clientId },
      data: { refusalCount: 2, assignedAgentId: agentId },
    });

    await createLeadFromChannel({ fullName: "Активный с отказами", phone, source: "WHATSAPP", kind: "BUYER" });

    const after = await prisma.client.findUnique({ where: { id: first.clientId } });
    // Клиент никогда не уходил в LOST/Неактивные — не «вернулся», а продолжает
    // разговор, сбрасывать отказы не за что.
    expect(after?.refusalCount).toBe(2);
  });
});
