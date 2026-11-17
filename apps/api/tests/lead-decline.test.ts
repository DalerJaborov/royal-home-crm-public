import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

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

/**
 * Баллы за отказы подряд (lead_declined_*) сняты 16.11.2026 вместе с остальными
 * автоматическими штрафами Royal Score — решение владельца. Счётчик отказов подряд
 * и передача лида дальше остались. Проверяем, что в журнал по отказу НЕ пишется
 * ничего: ждём, пока фоновые записи осядут, и смотрим на ноль.
 */
async function declineEvents(): Promise<number> {
  return waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId: agentAId, sourceId: { startsWith: `decline-${agentAId}-` } } }));
}

describe("Отклонить лид", () => {
  it("первый отказ подряд — лид уходит другому агенту, баллы не списываются", async () => {
    const lead = await makeLead("Первый отказ", agentAId);
    const res = await request(app).post(`/api/v1/clients/${lead.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.declineCount).toBe(1);
    // Не закрепляем конкретного агента: в базе теста могут быть и другие активные
    // агенты (сиды, соседние тестовые файлы), и выбор среди них — не то, что здесь
    // проверяется. Важно только, что лид ушёл ОТ отклонившего — не завис на нём.
    expect(res.body.reassignedTo).toBeTruthy();
    expect(res.body.reassignedTo).not.toBe(agentAId);
    expect(await declineEvents()).toBe(0);

    const after = await prisma.client.findUnique({ where: { id: lead.id } });
    expect(after?.assignedAgentId).toBe(res.body.reassignedTo);
    expect(after?.assignedAgentId).not.toBe(agentAId);
  });

  it("второй отказ подряд — счётчик 2, штрафа нет (снят 16.11.2026)", async () => {
    const lead1 = await makeLead("Второй отказ 1", agentAId);
    await request(app).post(`/api/v1/clients/${lead1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);

    const lead2 = await makeLead("Второй отказ 2", agentAId);
    const res = await request(app).post(`/api/v1/clients/${lead2.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.declineCount).toBe(2);
    expect(await declineEvents()).toBe(0);
  });

  it("успешное принятие лида обнуляет счётчик отказов", async () => {
    const lead1 = await makeLead("Перед сбросом", agentAId);
    await request(app).post(`/api/v1/clients/${lead1.id}/decline`).set("Authorization", `Bearer ${agentAToken}`);

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
