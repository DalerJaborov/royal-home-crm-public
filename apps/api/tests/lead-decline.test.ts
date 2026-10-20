import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS } from "../src/lib/scoreJournal.js";

/**
 * «Отклонить» лид (спецификация 01.08.2026, часть 1 и часть 3): рядом с «Принять»
 * есть «Отклонить». Первый отказ подряд — без штрафа, дальше штраф усиливается;
 * после успешного принятия ЛЮБОГО лида счётчик обнуляется. Отклонённый лид сразу
 * уходит следующему свободному агенту.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentAId: string;
let agentBId: string;
let agentAToken: string;
const clientIds: string[] = [];
let savedEscalateAfter: number;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeLead(fullName: string, agentId: string) {
  const c = await prisma.client.create({
    data: {
      fullName: `${fullName} ${runId}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      assignedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-отклонить-${runId}` } })).id;
  agentAId = (
    await prisma.agent.create({
      data: { fullName: "Агент А отклоняет", phone: `+992960${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentBId = (
    await prisma.agent.create({
      data: { fullName: "Агент Б свободный", phone: `+992961${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentAToken = await login(`+992960${runId}`);

  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadEscalateAfter: true } });
  savedEscalateAfter = s?.leadEscalateAfter ?? 3;
});

afterEach(async () => {
  // Счётчик отказов — общий на агента между тестами; сбрасываем, чтобы каждый тест
  // сам управлял своей последовательностью и не зависел от порядка выполнения.
  await prisma.agent.update({ where: { id: agentAId }, data: { consecutiveLeadDeclines: 0 } });
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: agentAId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { leadEscalateAfter: savedEscalateAfter } });
  await prisma.$disconnect();
});

/** Балл за отказ №n именно от этого лида (sourceId — на выдачу лида, см. recordDeclineScore). */
async function waitForEvent(n: number, clientId: string): Promise<{ delta: number; kind: string } | null> {
  const prefix = `decline-${agentAId}-${n}-${clientId}-`;
  for (let i = 0; i < 50; i++) {
    const found = await prisma.royalScoreEvent.findFirst({ where: { agentId: agentAId, sourceId: { startsWith: prefix } } });
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe("Отклонить лид", () => {
  it("первый отказ подряд — без штрафа, лид уходит другому агенту", async () => {
    const lead = await makeLead("Первый отказ", agentAId);
    const res = await request(app).post(`/api/v1/clients/${lead.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.declineCount).toBe(1);
    // Не закрепляем конкретного агента: в базе теста могут быть и другие активные
    // агенты (сиды, соседние тестовые файлы), и выбор среди них — не то, что здесь
    // проверяется. Важно только, что лид ушёл ОТ отклонившего — не завис на нём.
    expect(res.body.reassignedTo).toBeTruthy();
    expect(res.body.reassignedTo).not.toBe(agentAId);

    const event = await waitForEvent(1, lead.id);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("lead_declined_1");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.lead_declined_1);

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(res.body.reassignedTo);
    expect(after?.assignedAgentId).not.toBe(agentAId);
  });

  it("второй отказ подряд — штраф −1", async () => {
    const lead1 = await makeLead("Второй отказ 1", agentAId);
    await request(app).post(`/api/v1/clients/${lead1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    await waitForEvent(1, lead1.id);

    const lead2 = await makeLead("Второй отказ 2", agentAId);
    const res = await request(app).post(`/api/v1/clients/${lead2.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.declineCount).toBe(2);

    const event = await waitForEvent(2, lead2.id);
    expect(event?.kind).toBe("lead_declined_2");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.lead_declined_2);
  });

  it("успешное принятие лида обнуляет счётчик отказов", async () => {
    const lead1 = await makeLead("Перед сбросом", agentAId);
    await request(app).post(`/api/v1/clients/${lead1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(await waitForEvent(1, lead1.id)).not.toBeNull();

    const accepted = await makeLead("Принимается", agentAId);
    const acceptRes = await request(app)
      .post(`/api/v1/clients/${accepted.id}/accept`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(acceptRes.status).toBe(200);

    const agent = await prisma.agent.findUnique({ where: { id: agentAId }, select: { consecutiveLeadDeclines: true } });
    expect(agent?.consecutiveLeadDeclines).toBe(0);

    // Следующий отказ — снова «первый подряд», а не третий.
    const leadAfterReset = await makeLead("После сброса", agentAId);
    const res = await request(app)
      .post(`/api/v1/clients/${leadAfterReset.id}/decline`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.body.declineCount).toBe(1);
    // Штраф новой серии пишется, а не теряется дедупом прошлой серии
    // (23.09.2026, пункт 13: sourceId был `decline-<агент>-<n>`).
    const second = await waitForEvent(1, leadAfterReset.id);
    expect(second?.kind).toBe("lead_declined_1");
  });

  it("вторая серия отказов после сброса штрафуется снова (аудит 23.09.2026, №50)", async () => {
    // Серия 1: два отказа подряд.
    const a1 = await makeLead("Серия 1-1", agentAId);
    await request(app).post(`/api/v1/clients/${a1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    const a2 = await makeLead("Серия 1-2", agentAId);
    await request(app).post(`/api/v1/clients/${a2.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(await waitForEvent(2, a2.id)).not.toBeNull();

    // Сброс, как после принятого лида.
    await prisma.agent.update({ where: { id: agentAId }, data: { consecutiveLeadDeclines: 0 } });

    // Серия 2: снова два отказа — второй обязан дать свой штраф.
    const b1 = await makeLead("Серия 2-1", agentAId);
    await request(app).post(`/api/v1/clients/${b1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    const b2 = await makeLead("Серия 2-2", agentAId);
    const res = await request(app).post(`/api/v1/clients/${b2.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.body.declineCount).toBe(2);
    const event = await waitForEvent(2, b2.id);
    expect(event?.kind).toBe("lead_declined_2");
    const penalties = await prisma.royalScoreEvent.count({
      where: { agentId: agentAId, kind: "lead_declined_2", OR: [{ sourceId: { startsWith: `decline-${agentAId}-2-${a2.id}-` } }, { sourceId: { startsWith: `decline-${agentAId}-2-${b2.id}-` } }] },
    });
    expect(penalties).toBe(2);
  });

  it("нельзя отклонить чужой лид — 409 «уже у другого», не 403", async () => {
    const lead = await makeLead("Чужой лид", agentBId);
    const res = await request(app).post(`/api/v1/clients/${lead.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Заявка уже переназначена другому агенту");
  });

  it("руководитель не может отклонить чужой лид — штраф получил бы агент (аудит 23.09.2026, №39)", async () => {
    const { signAccessToken } = await import("../src/auth/jwt.js");
    const manager = await prisma.agent.create({
      data: { fullName: "Руководитель отклоняет", phone: `+992962${runId}`, role: "MANAGER", passwordHash: "x" },
    });
    try {
      const lead = await makeLead("Лид агента А", agentAId);
      const res = await request(app)
        .post(`/api/v1/clients/${lead.id}/decline`)
        .set("Authorization", `Bearer ${signAccessToken({ sub: manager.id, role: "MANAGER" })}`);
      expect(res.status).toBe(403);
      const a = await prisma.agent.findUniqueOrThrow({ where: { id: agentAId }, select: { consecutiveLeadDeclines: true } });
      expect(a.consecutiveLeadDeclines).toBe(0);
      const still = await prisma.client.findUniqueOrThrow({ where: { id: lead.id }, select: { assignedAgentId: true } });
      expect(still.assignedAgentId).toBe(agentAId);
    } finally {
      await prisma.agent.delete({ where: { id: manager.id } });
    }
  });

  it("нельзя отклонить уже принятый лид", async () => {
    const lead = await makeLead("Уже принят", agentAId);
    await request(app).post(`/api/v1/clients/${lead.id}/accept`).set("Authorization", `Bearer ${agentAToken}`);
    const res = await request(app).post(`/api/v1/clients/${lead.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(409);
  });

  it("несуществующий клиент — 404", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/00000000-0000-0000-0000-000000000000/decline`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(404);
  });
});
