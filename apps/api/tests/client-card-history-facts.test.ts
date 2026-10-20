import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Аудит 04.10.2026, WEB-PAGES21: карточка отдаёт только последние 200 записей
 * хронологии, а фронт выводил из них «был проведённый показ», «был настоящий
 * разговор» и счёт звонков. После 200 новых служебных записей кнопки «Завершить
 * сделку» и «Передать» прятались, а вкладка звонков говорила «разговоров не
 * было». Теперь эти факты считает сервер по ПОЛНОЙ таблице.
 */
const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
let clientId: string;
let freshClientId: string;
let pendingClientId: string;

const longAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

async function card(id: string) {
  const res = await request(app).get(`/api/v1/clients/${id}`).set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент фактов ${runId}`, phone: `+992940${String(runId).slice(-9)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;

  const mk = async (suffix: string, accepted: boolean) =>
    (
      await prisma.client.create({
        data: {
          fullName: `Клиент фактов ${suffix} ${runId}`,
          phone: `+99294${suffix}${String(runId).slice(-8)}`,
          source: "PHONE_CALL",
          assignedAgentId: agentId,
          acceptedAt: accepted ? new Date() : null,
        },
      })
    ).id;
  clientId = await mk("1", true);
  freshClientId = await mk("2", true);
  pendingClientId = await mk("3", false);

  // Давний проведённый показ и разговор дольше порога, затем 250 свежих служебных записей.
  await prisma.interaction.createMany({
    data: [
      { clientId, agentId, type: "SHOWING", notes: "Показ проведён", completedAt: longAgo(60), createdAt: longAgo(60) },
      { clientId, agentId, type: "CALL", notes: "Долгий разговор", recordingDurationSec: 120, createdAt: longAgo(59) },
      { clientId, agentId, type: "CALL", notes: "Недозвон", recordingDurationSec: 3, createdAt: longAgo(58) },
      ...Array.from({ length: 250 }, (_, i) => ({
        clientId,
        agentId,
        type: "SYSTEM" as const,
        notes: `служебная запись ${i}`,
        createdAt: new Date(Date.now() - 60_000 + i),
      })),
    ],
  });
  // Клиент без показа и без разговоров.
  await prisma.interaction.create({
    data: { clientId: freshClientId, agentId, type: "SYSTEM", notes: "завели", createdAt: new Date() },
  });
  // Непринятый лид: история закрыта целиком, факты не раскрываем.
  await prisma.interaction.create({
    data: { clientId: pendingClientId, agentId, type: "SHOWING", notes: "x", completedAt: longAgo(5), createdAt: longAgo(5) },
  });
});

afterAll(async () => {
  const ids = [clientId, freshClientId, pendingClientId];
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("карточка клиента: факты истории считаются по полной таблице", () => {
  it("хронология усечена до 200, а факты о старых записях на месте", async () => {
    const body = await card(clientId);
    expect(body.interactions).toHaveLength(200);
    expect(body.interactionsTotal).toBe(253);
    // Ни показа, ни звонков в последних 200 нет, но они были.
    expect(body.interactions.some((i: { type: string }) => i.type === "SHOWING" || i.type === "CALL")).toBe(false);
    expect(body.hadConductedShowing).toBe(true);
    expect(body.callsCount).toBe(2);
    expect(body.hadRealCall).toBe(true);
  });

  it("клиент без показа и разговоров: факты ложные", async () => {
    const body = await card(freshClientId);
    expect(body.hadConductedShowing).toBe(false);
    expect(body.callsCount).toBe(0);
    expect(body.hadRealCall).toBe(false);
  });

  it("до приёма лида факты не раскрываются", async () => {
    const body = await card(pendingClientId);
    expect(body.interactions).toEqual([]);
    expect(body.hadConductedShowing).toBe(false);
    expect(body.callsCount).toBe(0);
    expect(body.hadRealCall).toBe(false);
  });
});
