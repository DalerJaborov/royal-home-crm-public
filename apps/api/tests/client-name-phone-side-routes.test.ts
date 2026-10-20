import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { issueLeadActionToken } from "../src/lib/pushLeadActions.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A11 — класс «номер в имени» в боковых ответах.
 *
 * Карточки незнакомых звонивших CRM до 20.08.2026 заводила с ОТКРЫТЫМ номером в
 * имени («Входящий +992…», lib/clientPhone.ts). Карточка и списки это давно
 * учитывают (presentClient, withMaskedClient), а несколько боковых ответов брали
 * fullName как есть:
 *  - тост «… принят — контакты открыты» после «Принять» прямо из пуша;
 *  - шапка выгрузки переписки (txt и json);
 *  - «Ждёт агента» в сводке раздела «Клиенты»;
 *  - очередь споров о числе объектов у руководства;
 *  - предупреждение о пересечении показов в ответе на новую запись.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const NAME_DIGITS = `918${runId.slice(-6)}`;
const PHONE_NAME = `Входящий +992${NAME_DIGITS}`;

const agentIds: string[] = [];
const clientIds: string[] = [];
let agentId: string;
let agentToken: string;
let managerToken: string;
let pendingLeadId: string;
let acceptedShortId: number;
let acceptedId: string;
let otherAcceptedId: string;
let disputeId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(i: number, extra: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: PHONE_NAME,
      phone: `+99298${i}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A11 ${runId}`, phone: `+992985${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель A11 ${runId}`, phone: `+992986${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(agent.id, manager.id);

  pendingLeadId = (await makeClient(1, { assignedAt: new Date(), acceptedAt: null })).id;
  const accepted = await makeClient(2, { acceptedAt: new Date() });
  acceptedId = accepted.id;
  acceptedShortId = accepted.shortId;
  otherAcceptedId = (await makeClient(3, { acceptedAt: new Date() })).id;
  disputeId = (
    await prisma.propertyCountDispute.create({
      data: { clientId: acceptedId, requestedById: agent.id, role: "BUYER", aiCount: 1, proposedCount: 2, reason: "проверка A11" },
    })
  ).id;

  agentToken = await login(agent.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.propertyCountDispute.deleteMany({ where: { id: disputeId } });
  await prisma.pushActionToken.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A11: имя-номер не уходит тем, кому номер скрыт", () => {
  it("сводка раздела «Клиенты» — «Ждёт агента»", async () => {
    const res = await request(app).get("/api/v1/clients/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.awaitingAgent.oldest).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(NAME_DIGITS);
  });

  it("выгрузка переписки — txt и json", async () => {
    for (const format of ["txt", "json"]) {
      const res = await request(app)
        .get(`/api/v1/clients/${acceptedShortId}/conversation-export`)
        .query({ format })
        .set("Authorization", `Bearer ${agentToken}`)
        .buffer(true)
        .parse((r, cb) => {
          let data = "";
          r.on("data", (chunk: Buffer) => (data += chunk.toString()));
          r.on("end", () => cb(null, data));
        });
      expect(res.status).toBe(200);
      expect(res.body as string).toContain("Входящий");
      expect(res.body as string).not.toContain(NAME_DIGITS);
    }
  });

  it("очередь споров о числе объектов у руководителя без права на номера", async () => {
    const res = await request(app)
      .get("/api/v1/clients/property-count-disputes")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const row = (res.body.items as { id: string }[]).find((r) => r.id === disputeId);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(NAME_DIGITS);
  });

  it("пересечение показов в ответе на новую запись", async () => {
    const at = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await prisma.interaction.create({
      data: { clientId: otherAcceptedId, agentId, type: "SHOWING", notes: "показ", nextAction: "Показ", nextActionDate: at },
    });
    const res = await request(app)
      .post(`/api/v1/clients/${acceptedId}/interactions`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ type: "SHOWING", notes: "ещё показ", nextAction: "Показ", nextActionDate: at.toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.showingConflict).toBeDefined();
    expect(JSON.stringify(res.body.showingConflict)).not.toContain(NAME_DIGITS);
  });

  it("тост после «Принять» из пуша", async () => {
    const token = await issueLeadActionToken(agentId, pendingLeadId, 10);
    const res = await request(app).post("/api/v1/push/action").send({ token, action: "lead-accept" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain("принят");
    expect(res.body.message).not.toContain(NAME_DIGITS);
  });
});
