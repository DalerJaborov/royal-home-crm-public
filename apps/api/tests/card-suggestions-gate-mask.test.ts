import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A6 — история подсказок ИИ по карточке
 * (`GET /clients/:id/card-suggestions`).
 *
 * Единственной проверкой был canAccessAssignedAgent. Карточка до принятия лида
 * агенту закрыта (бюджет, район, переписка — gateUntilAccepted в card.ts), а
 * подсказки отдавали тот же бюджет и дословные цитаты клиента. Удалённый клиент
 * тоже отвечал. Цитаты (evidence), заметка и адрес — свободный текст со слов
 * клиента, номер в них шёл открытым агенту без clients.viewPhone.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const DIGITS = "935557788";

const agentIds: string[] = [];
const clientIds: string[] = [];
let agentId: string;
let pendingId: string;
let acceptedId: string;
let deletedId: string;
let agentToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(name: string, extra: { acceptedAt?: Date | null; deletedAt?: Date | null }) {
  const c = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+99297${String(clientIds.length)}${runId}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: extra.acceptedAt ?? null,
      deletedAt: extra.deletedAt ?? null,
    },
  });
  clientIds.push(c.id);
  await prisma.cardSuggestion.create({
    data: {
      clientId: c.id,
      agentId,
      budgetMax: 80000,
      notes: `Перезвонить на ${DIGITS}`,
      address: `Сино, дом 5, тел ${DIGITS}`,
      evidence: [`мой номер ${DIGITS}, звоните вечером`],
      status: "applied",
    },
  });
  return c.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент A6 ${runId}`, phone: `+992976${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentIds.push(agent.id);
  pendingId = await makeClient("Непринятый A6", { acceptedAt: null });
  acceptedId = await makeClient("Принятый A6", { acceptedAt: new Date() });
  deletedId = await makeClient("Удалённый A6", { acceptedAt: new Date(), deletedAt: new Date() });
  agentToken = await login(agent.phone);
});

afterAll(async () => {
  await prisma.cardSuggestion.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A6: подсказки ИИ по карточке — тот же гейт и та же маска, что у карточки", () => {
  it("до принятия лида — закрыто", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${pendingId}/card-suggestions`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("клиент в Корзине — не найден", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${deletedId}/card-suggestions`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
  });

  it("принятый клиент — история есть, номер в цитатах, заметке и адресе скрыт", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${acceptedId}/card-suggestions`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].budgetMax).toBe(80000);
    expect(res.body[0].evidence[0]).toContain("звоните вечером");
    expect(JSON.stringify(res.body)).not.toContain("5557788");
  });
});
