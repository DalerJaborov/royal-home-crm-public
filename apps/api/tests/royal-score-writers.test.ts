import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { DEFAULT_EVENT_POINTS } = await import("../src/lib/scoreJournal.js");

/**
 * Писатели Royal Score, подключённые к реальным действиям (Этап 1, план после
 * фундамента движка): показ/встреча/задача при закрытии, объект при создании,
 * (до 16.11.2026 ещё и штрафы — незаполненная карточка, пропущенный показ; сняты). Полный список пока НЕ подключённых событий (нужны новые
 * фичи — кнопки одобрения фото/видео, «Отклонить» лид и т.д.) — в
 * docs/spec-compliance-03-08-2026.md.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let agentToken: string;
let clientId: string;
let propertyId: string;
const interactionIds: string[] = [];
const extraClientIds: string[] = [];
const extraPropertyIds: string[] = [];

async function waitForEvent(sourceId: string, kind: string): Promise<{ delta: number } | null> {
  for (let i = 0; i < 50; i++) {
    const found = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId, kind } });
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-писатели-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент писателей", phone: `+99290${runId.toString().slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  agentToken = res.body.accessToken as string;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент писателей ${runId}`,
      phone: `+99289${runId.toString().slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;

  const property = await prisma.property.create({
    data: {
      title: `Объект писателей ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.pendingSummary.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { OR: [{ clientId }, { clientId: { in: extraClientIds } }] } });
  await prisma.client.deleteMany({ where: { id: { in: [clientId, ...extraClientIds] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, ...extraPropertyIds] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeTask(type: "SHOWING" | "MEETING" | "CALL", minutesAhead: number, nowMs = Date.now()) {
  const t = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type,
      propertyId: type === "SHOWING" ? propertyId : null,
      notes: `Задача ${type} ${runId}`,
      nextAction: "Проверка Royal Score",
      nextActionDate: new Date(nowMs + minutesAhead * 60_000),
    },
  });
  interactionIds.push(t.id);
  return t;
}

describe("Закрытие задачи через /interactions/:id/complete", () => {
  it("показ, закрытый вовремя — showing_done", async () => {
    const task = await makeTask("SHOWING", 60); // ещё впереди — закрываем «вовремя»
    const res = await request(app)
      .patch(`/api/v1/interactions/${task.id}/complete`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const event = await waitForEvent(task.id, "showing_done");
    expect(event).not.toBeNull();
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.showing_done);
  });

  it("показ, закрытый с опозданием — ни showing_done, ни штрафа (штраф снят 16.11.2026)", async () => {
    const task = await makeTask("SHOWING", -30); // время уже прошло
    const res = await request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const events = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { sourceId: task.id } }));
    expect(events).toBe(0);
  });

  it("встреча, закрытая вовремя — meeting_done", async () => {
    const task = await makeTask("MEETING", 60);
    await request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    const event = await waitForEvent(task.id, "meeting_done");
    expect(event).not.toBeNull();
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.meeting_done);
  });

  it("обычная задача вовремя — task_on_time; просроченная — без баллов", async () => {
    const onTime = await makeTask("CALL", 60);
    await request(app).patch(`/api/v1/interactions/${onTime.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    expect(await waitForEvent(onTime.id, "task_on_time")).not.toBeNull();

    const late = await makeTask("CALL", -30);
    await request(app).patch(`/api/v1/interactions/${late.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    expect(await waitForSettled(() => prisma.royalScoreEvent.count({ where: { sourceId: late.id } }))).toBe(0);
  });

  it("повторное закрытие уже выполненной задачи не начисляет баллы второй раз", async () => {
    const task = await makeTask("CALL", 60);
    await request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    await waitForEvent(task.id, "task_on_time");
    await request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    const count = await waitForSettled(() =>
      prisma.royalScoreEvent.count({ where: { sourceId: task.id, kind: "task_on_time" } })
    );
    expect(count).toBe(1);
  });

  it("два одновременных закрытия — один переход и один балл", async () => {
    /**
     * Признаком «первого закрытия» было прочитанное до записи `completedAt`, а между
     * чтением и записью помещается второй такой же запрос (двойной клик, повтор с
     * телефона): оба видели null и оба заходили в начисление. От двойных баллов
     * спасала только уникальность sourceId в журнале — то есть защита жила не там,
     * где гонка, и любое событие без sourceId её бы не получило. Переход забирается
     * атомарно (updateMany с условием completedAt: null).
     */
    const task = await makeTask("CALL", 60);
    const [a, b] = await Promise.all([
      request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`),
      request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Оба ответа отдают закрытую задачу — второй не должен выглядеть «ещё открытой».
    expect(a.body.completedAt).toBeTruthy();
    expect(b.body.completedAt).toBeTruthy();

    expect(await waitForEvent(task.id, "task_on_time")).not.toBeNull();
    expect(await waitForSettled(() => prisma.royalScoreEvent.count({ where: { sourceId: task.id } }))).toBe(1);
  });

  it("балл записан ДО ответа 200: падение сразу после ответа его не теряет", async () => {
    // recordScoreEvent ждётся внутри маршрута — без этого ответ уходил раньше записи,
    // а повторный PATCH в ветку начисления уже не заходит: второго шанса нет.
    const task = await makeTask("CALL", 60);
    await request(app).patch(`/api/v1/interactions/${task.id}/complete`).set("Authorization", `Bearer ${agentToken}`);
    expect(await prisma.royalScoreEvent.findFirst({ where: { sourceId: task.id, kind: "task_on_time" } })).not.toBeNull();
  });
});

describe("Создание объекта", () => {
  it("POST /properties начисляет property_added агенту-интейку", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({
        type: "APARTMENT",
        districtId,
        address: "Новая, 5",
        areaSqm: 45,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 35000,
        currency: "TJS",
        condition: "GOOD",
        ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      });
    expect(res.status).toBe(201);
    extraPropertyIds.push(res.body.id);
    const event = await waitForEvent(res.body.id, "property_added");
    expect(event).not.toBeNull();
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.property_added);
  });
});

// «Незаполненная карточка» (card_not_filled, lib/cardReminders.ts) и «показ, ни
// разу не отмеченный» (showing_missed, notifyMissedShowings) удалены 16.11.2026
// вместе с автоматическими штрафами Royal Score — решение владельца.
