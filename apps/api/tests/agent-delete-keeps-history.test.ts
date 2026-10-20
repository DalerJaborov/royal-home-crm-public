import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * «Удалить сотрудника» не стирает его журнал (находка №195, ночная проверка
 * 24.09.2026). Сотрудник без звонков и сделок раньше удалялся строкой целиком, и
 * база каскадом уносила журнал входов, Royal Score, KPI, журнал ИИ-ассистента,
 * заявки на удаление и споры с решениями. Теперь при любой такой истории учётка
 * отключается и освобождает номер (как при сделках), а журнал остаётся целым.
 */

const runId = Date.now();
const password = "testpass123";
let adminId: string;
let adminToken: string;
const created: string[] = [];

async function makeVictim(label: string) {
  const a = await prisma.agent.create({
    data: {
      fullName: `Удаляемый ${label} ${runId}`,
      phone: `+99294${String(created.length)}${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  created.push(a.id);
  return a;
}

function del(id: string) {
  grantElevation(adminId);
  return request(app).delete(`/api/v1/agents/${id}`).set("Authorization", `Bearer ${adminToken}`);
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: "Админ удаления", phone: `+992938${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
  });
  adminId = admin.id;
  created.push(admin.id);
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.loginLog.deleteMany({ where: { agentId: { in: created } } });
  await prisma.royalScoreEvent.deleteMany({ where: { agentId: { in: created } } });
  await prisma.kpiDailyScore.deleteMany({ where: { agentId: { in: created } } });
  await prisma.aiAssistantAuditLog.deleteMany({ where: { agentId: { in: created } } });
  await prisma.session.deleteMany({ where: { agentId: { in: created } } });
  await prisma.agent.deleteMany({ where: { id: { in: created } } });
});

describe("DELETE /agents/:id — у сотрудника есть история", () => {
  it("только журнал входов: учётка отключена, журнал цел, ответ по-русски объясняет почему", async () => {
    const a = await makeVictim("вход");
    await prisma.loginLog.create({ data: { agentId: a.id, ip: "127.0.0.1" } });

    const res = await del(a.id);
    expect(res.status).toBe(200);
    expect(res.body.deactivatedInsteadOfDeleted).toBe(true);
    expect(res.body.message).toMatch(/истори/);

    const row = await prisma.agent.findUnique({ where: { id: a.id } });
    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(false);
    expect(row!.phone).toContain(`${a.id}-deleted:`);
    expect(await prisma.loginLog.count({ where: { agentId: a.id } })).toBe(1);
  });

  it("только Royal Score: журнал баллов не стирается", async () => {
    const a = await makeVictim("баллы");
    await prisma.royalScoreEvent.create({ data: { agentId: a.id, kind: "test", delta: 1, reason: "тест" } });

    const res = await del(a.id);
    expect(res.status).toBe(200);
    expect(res.body.deactivatedInsteadOfDeleted).toBe(true);
    expect(await prisma.royalScoreEvent.count({ where: { agentId: a.id } })).toBe(1);
  });

  it("KPI и журнал ИИ-ассистента — тоже история", async () => {
    const a = await makeVictim("кпи");
    await prisma.kpiDailyScore.create({ data: { agentId: a.id, date: new Date("2026-09-01T00:00:00Z"), score: 5 } });
    await prisma.aiAssistantAuditLog.create({ data: { agentId: a.id, tool: "test" } });

    const res = await del(a.id);
    expect(res.body.deactivatedInsteadOfDeleted).toBe(true);
    expect(await prisma.kpiDailyScore.count({ where: { agentId: a.id } })).toBe(1);
    expect(await prisma.aiAssistantAuditLog.count({ where: { agentId: a.id } })).toBe(1);
  });

  it("совсем без истории — строка стирается, как и раньше", async () => {
    const a = await makeVictim("пустой");
    const res = await del(a.id);
    expect(res.status).toBe(200);
    expect(res.body.deactivatedInsteadOfDeleted).toBeUndefined();
    expect(await prisma.agent.findUnique({ where: { id: a.id } })).toBeNull();
  });
});
