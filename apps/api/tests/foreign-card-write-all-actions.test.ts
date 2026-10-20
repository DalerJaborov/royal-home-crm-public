import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «ВИДЕТЬ — НО НЕ МЕНЯТЬ» ВО ВСЕХ ДЕЙСТВИЯХ (23.09.2026, аудит №29).
 *
 * Служба безопасности видит все карточки (clients.viewAll), но не распределяет
 * лидов (clients.assign) — и по решению владельца не должна менять разбираемое.
 * Запрет (foreignWriteDenied) стоял на правке карточки и передаче, но не на
 * паузе бота, возврате из «Отложенных», отметке «выполнено» у задачи агента,
 * отмене и переносе показа.
 *
 * Заодно: показ, назначенный ботом (agentId пуст, агент в subjectAgentId, П-10),
 * свой агент отменить не мог — проверка смотрела только на agentId.
 */

const runId = Date.now();
const tail = String(runId).slice(-6);
let agentId = "";
let securityId = "";
let agentToken = "";
let securityToken = "";
let clientId = "";
let taskId = "";
let showingId = "";
let botShowingId = "";
let convId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент карточки ${runId}`, phone: `+992916${tail}`, role: "AGENT", passwordHash: "x" },
  });
  const security = await prisma.agent.create({
    data: { fullName: `СБ карточки ${runId}`, phone: `+992917${tail}`, role: "SECURITY", passwordHash: "x" },
  });
  agentId = agent.id;
  securityId = security.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });

  const phone = `+992918${tail}`;
  await prisma.client.deleteMany({ where: { phone } });
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент чужой ${runId}`,
      phone,
      source: "INSTAGRAM",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      workStatus: "DEFERRED",
      deferredUntil: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  clientId = client.id;
  convId = (
    await prisma.botConversation.create({
      data: { channel: "INSTAGRAM", subscriberId: `foreign-${runId}`, messages: [], clientId },
    })
  ).id;
  const future = new Date(Date.now() + 2 * 86_400_000);
  taskId = (
    await prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Перезвонить", nextAction: "Перезвонить", nextActionDate: future },
    })
  ).id;
  showingId = (
    await prisma.interaction.create({
      data: { clientId, agentId, type: "SHOWING", notes: "Показ", nextAction: "Показ", nextActionDate: future },
    })
  ).id;
  botShowingId = (
    await prisma.interaction.create({
      data: {
        clientId,
        agentId: null,
        actorKind: "BOT",
        subjectAgentId: agentId,
        type: "SHOWING",
        notes: "Бот назначил показ",
        nextAction: "Показ",
        nextActionDate: future,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: convId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, securityId] } } });
});

describe("Служба безопасности не меняет чужую карточку ни одним действием", () => {
  it("пауза бота", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/bot-pause`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ pausedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(403);
    const conv = await prisma.botConversation.findUnique({ where: { id: convId }, select: { pausedUntil: true } });
    expect(conv?.pausedUntil).toBeNull();
  });

  it("возврат из «Отложенных»", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientId}/deferred/return`)
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(403);
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { workStatus: true } });
    expect(c?.workStatus).toBe("DEFERRED");
  });

  it("«выполнено» у задачи агента", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${taskId}/complete`)
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(403);
    const t = await prisma.interaction.findUnique({ where: { id: taskId }, select: { completedAt: true } });
    expect(t?.completedAt).toBeNull();
  });

  it("отмена и перенос показа", async () => {
    const cancel = await request(app)
      .patch(`/api/v1/interactions/${showingId}/showing/cancel`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ reason: "проверка службы" });
    expect(cancel.status).toBe(403);
    const move = await request(app)
      .patch(`/api/v1/interactions/${showingId}/showing/reschedule`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ at: new Date(Date.now() + 3 * 86_400_000).toISOString(), reason: "проверка службы" });
    expect(move.status).toBe(403);
  });
});

describe("Свой агент", () => {
  it("может отменить показ, который назначил бот", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${botShowingId}/showing/cancel`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ reason: "клиент перенёс" });
    expect(res.status).not.toBe(403);
  });
});
