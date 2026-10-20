import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА 02.10.2026, A1 и A2 — запись хронологии уходила наружу сырой.
 *
 * Класс уже чинили в календаре 22.09.2026 (routes/calendar.ts: presentInteractions
 * поверх withMaskedClient). Два ответа остались в стороне:
 *
 * A1. `GET /dashboard/summary` — «Задачи на сегодня» и лента активности выбирают
 *     Interaction через `include` без `select`, то есть отдают ВСЕ скаляры записи:
 *     расшифровку, перевод, разбор ИИ, ссылку на запись, заметки. У руководства
 *     лента идёт по всей компании, а права на чужие разговоры (calls.transcripts)
 *     у пресета MANAGER нет.
 * A2. `PATCH /interactions/:id/complete` возвращал запись из базы как есть.
 *
 * Правильно — тот же presentInteraction (lib/callTranscripts.ts), что и везде:
 * чужой разговор закрыт, номера в свободном тексте маскируются без clients.viewPhone.
 */

const runId = `${Date.now()}`.slice(-7);
const password = "testpass123";
const SPOKEN_PHONE = "+992 93 555 12 34";
const TRANSCRIPT = `Клиент: да, перезвоните на ${SPOKEN_PHONE}, я продаю квартиру`;

const agentIds: string[] = [];
let callerId: string;
let callerToken: string;
let managerToken: string;
let clientId: string;
let foreignCallId: string;
let ownCallId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function expectClosed(row: Record<string, unknown>) {
  expect(row.transcript).toBeNull();
  expect(row.transcriptRu).toBeNull();
  expect(row.callAnalysis).toBeNull();
  expect(row.recordingUrl).toBeNull();
  expect(JSON.stringify(row)).not.toContain("555 12 34");
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const caller = await prisma.agent.create({
    data: { fullName: `Звонящий агент A1 ${runId}`, phone: `+992971${runId}`, role: "AGENT", passwordHash },
  });
  callerId = caller.id;
  agentIds.push(caller.id);
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель A1 ${runId}`, phone: `+992972${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(manager.id);

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент A1 ${runId}`,
      phone: `+992973${runId}`,
      kind: "SELLER",
      source: "WALK_IN",
      assignedAgentId: caller.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const callData = {
    clientId,
    agentId: caller.id,
    type: "CALL" as const,
    notes: `Просил перезвонить на ${SPOKEN_PHONE}`,
    transcript: TRANSCRIPT,
    transcriptRu: TRANSCRIPT,
    recordingUrl: `https://pbx.example/rec-${runId}.mp3`,
    nextAction: "Перезвонить",
    nextActionDate: new Date(),
  };
  foreignCallId = (await prisma.interaction.create({ data: callData })).id;
  ownCallId = (await prisma.interaction.create({ data: callData })).id;

  callerToken = await login(caller.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces(agentIds);
});

describe("A1: Главная не отдаёт разговоры сырыми", () => {
  it("руководителю без calls.transcripts чужой звонок в ленте и задачах — без текста и записи", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const recent = (res.body.recentActivity as Record<string, unknown>[]).find((i) => i.id === foreignCallId);
    expect(recent).toBeDefined();
    expectClosed(recent!);
    const task = (res.body.tasksToday as Record<string, unknown>[]).find((i) => i.id === foreignCallId);
    expect(task).toBeDefined();
    expectClosed(task!);
  });

  it("агенту без clients.viewPhone свой звонок читается, но номер в тексте скрыт", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${callerToken}`);
    expect(res.status).toBe(200);
    const recent = (res.body.recentActivity as Record<string, unknown>[]).find((i) => i.id === foreignCallId);
    expect(recent).toBeDefined();
    expect(typeof recent!.transcript).toBe("string");
    expect(JSON.stringify(recent)).not.toContain("555 12 34");
  });
});

describe("A2: закрытие задачи отвечает той же маской, что и чтение", () => {
  it("руководитель закрывает чужую задачу по звонку — расшифровки и записи в ответе нет", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${foreignCallId}/complete`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBeTruthy();
    expectClosed(res.body);
  });

  it("агент закрывает свою задачу — номер, продиктованный в звонке, скрыт", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${ownCallId}/complete`)
      .set("Authorization", `Bearer ${callerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(callerId);
    expect(typeof res.body.transcript).toBe("string");
    expect(JSON.stringify(res.body)).not.toContain("555 12 34");
  });
});
