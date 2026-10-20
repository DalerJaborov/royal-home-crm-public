import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ЧАТЫ АГЕНТА — ТОЛЬКО ЕГО КЛИЕНТЫ (владелец 07.09.2026: «календарь убери, вместо
 * него чат был... переписки у всех агентов не работают, почини везде»).
 *
 * Раздел «Сообщения» открыт агенту новым правом `messages.viewOwn`. До этой правки
 * маршрут отдавал ВСЕ переписки агентства всем, у кого есть доступ к разделу, —
 * то есть выдать агенту галочку «Сообщения» значило открыть ему переписку по чужим
 * клиентам целиком. Сужение делает сервер, и проверяется оно здесь: право, которое
 * соблюдает только интерфейс, — не право, а надпись.
 *
 * Проверяется ровно то, что можно потерять одной правкой SQL:
 *  1. в списке агент видит свой диалог и НЕ видит чужой;
 *  2. чужой диалог не открывается по прямой ссылке (404, а не 403 — существование
 *     чужих диалогов не подтверждаем);
 *  3. в чужой диалог нельзя ответить;
 *  4. диалог по НЕПРИНЯТОМУ лиду закрыт так же, как закрыта карточка до принятия;
 *  5. руководителю по-прежнему видно всё.
 */

const runId = Date.now();
const password = "testpass123";

let agentId = "";
let otherAgentId = "";
let directorId = "";
let agentToken = "";
let directorToken = "";
const clientIds: string[] = [];
const convIds: string[] = [];

/** id диалогов по ролям — их и проверяем в списке. */
let ownConvId = "";
let foreignConvId = "";
let notAcceptedConvId = "";

async function makeAgent(name: string, role: "AGENT" | "DIRECTOR", suffix: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.agent.create({
    data: { fullName: `${name} ${runId}`, phone: `+9929${suffix}${String(runId).slice(-6)}`, role, passwordHash },
  });
}

async function makeClientWithConversation(opts: { agent: string; accepted: boolean; tag: string }) {
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент чатов ${opts.tag} ${runId}`,
      phone: `+9928${opts.tag}${String(runId).slice(-6)}`,
      source: "INSTAGRAM",
      assignedAgentId: opts.agent,
      acceptedAt: opts.accepted ? new Date() : null,
    },
  });
  clientIds.push(client.id);
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `scope-${opts.tag}-${runId}`,
      clientId: client.id,
      lastMessageAt: new Date(),
      messages: [{ role: "user", content: `реплика ${opts.tag}`, at: new Date().toISOString() }],
    },
  });
  convIds.push(conv.id);
  return conv.id;
}

beforeAll(async () => {
  const agent = await makeAgent("Агент чатов", "AGENT", "1");
  const other = await makeAgent("Чужой агент", "AGENT", "2");
  const director = await makeAgent("Директор чатов", "DIRECTOR", "3");
  agentId = agent.id;
  otherAgentId = other.id;
  directorId = director.id;

  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;
  directorToken = (await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password })).body
    .accessToken;

  ownConvId = await makeClientWithConversation({ agent: agentId, accepted: true, tag: "own" });
  foreignConvId = await makeClientWithConversation({ agent: otherAgentId, accepted: true, tag: "for" });
  notAcceptedConvId = await makeClientWithConversation({ agent: agentId, accepted: false, tag: "new" });
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId, directorId] } } });
  await prisma.$disconnect();
});

describe("Чаты агента суживаются до его клиентов", () => {
  it("в списке виден свой диалог и не виден чужой", async () => {
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(ownConvId);
    expect(ids).not.toContain(foreignConvId);
  });

  it("диалог по непринятому лиду закрыт так же, как карточка до принятия", async () => {
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${agentToken}`);
    const ids = (res.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(notAcceptedConvId);
  });

  it("чужой диалог не открывается по прямой ссылке — 404, а не 403", async () => {
    const res = await request(app)
      .get(`/api/v1/conversations/${foreignConvId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("в чужой диалог нельзя ответить", async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${foreignConvId}/reply`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "не должно уйти" });
    expect(res.status).toBe(404);
  });

  it("свой диалог открывается", async () => {
    const res = await request(app).get(`/api/v1/conversations/${ownConvId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
  });

  it("руководителю видно и своё, и чужое — сужение только для агента", async () => {
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(ownConvId);
    expect(ids).toContain(foreignConvId);
  });
});
