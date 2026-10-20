import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { AUTO_THINKING_MARKER, runBuyerThinkingSlowTrackTick } from "../src/lib/buyerThinkingSlowTrack.js";

/**
 * «Покупатель думает» — авто-подстраховка (владелец 30.08.2026). Регрессионный
 * тест на реальный баг, найденный 30.08.2026 живой проверкой: первая версия
 * останавливала трек проверкой `Client.buyerStage === "THINKING"`, а такого
 * значения в enum BuyerStage нет и никогда не было (только SELECTION/NEGOTIATION) —
 * условие было ложно всегда, трек молча умирал после первого же напоминания,
 * ни разу не дойдя до шага 2. Тесты здесь держат три вещи одновременно:
 * эскалация действительно продвигается, дедуп не плодит вторых копий, и
 * остановка (закрытая карточка / свежий «Итог показа») действительно тормозит.
 */

const SECOND_TIER_MARKER = "Связаться с клиентом — думает над показом (авто-подстраховка, шаг 2)";
const SLOW_TRACK_MARKER = "Связаться с клиентом — думает над показом (медленный трек)";
const FINAL_TRACK_MARKER = "Связаться с клиентом — думает над показом (финальный темп)";

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
const clientIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Думающий покупатель ${runId}-${clientIds.length}`,
      phone: `+992909${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeOverdueTask(clientId: string, marker: string) {
  await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SYSTEM",
      notes: "тест",
      nextAction: marker,
      nextActionDate: new Date(Date.now() - 3600_000),
    },
  });
}

// Симулирует уже отработанный (закрытый) еженедельный цикл — для счётчика
// completedCycles в advanceSlowTrackTier важно только completedAt !== null,
// сама дата в прошлом роли не играет.
async function makeCompletedSlowTrackCycle(clientId: string) {
  await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SYSTEM",
      notes: "тест — уже отработанный цикл",
      nextAction: SLOW_TRACK_MARKER,
      nextActionDate: new Date(Date.now() - 8 * 86_400_000),
      completedAt: new Date(Date.now() - 86_400_000),
    },
  });
}

let savedSlowTrackCycles: number;
let savedFinalTrackDays: number;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент думающего трека", phone: `+992965${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  token = await login(agent.phone);

  // Фиксируем детерминированные значения на время теста (владелец 01.09.2026:
  // buyerThinkingSlowTrackCycles/buyerThinkingFinalTrackDays), чтобы не зависеть
  // от того, что реально стоит в singleton-настройках дев-базы.
  const current = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
  savedSlowTrackCycles = current.buyerThinkingSlowTrackCycles;
  savedFinalTrackDays = current.buyerThinkingFinalTrackDays;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { buyerThinkingSlowTrackCycles: 2, buyerThinkingFinalTrackDays: 10 },
  });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { buyerThinkingSlowTrackCycles: savedSlowTrackCycles, buyerThinkingFinalTrackDays: savedFinalTrackDays },
  });
});

describe("runBuyerThinkingSlowTrackTick", () => {
  it("шаг 1 просрочен, клиент активен — продвигает на шаг 2 (регрессия: buyerStage не участвует)", async () => {
    const c = await makeClient();
    await makeOverdueTask(c.id, AUTO_THINKING_MARKER);

    const result = await runBuyerThinkingSlowTrackTick();
    expect(result.advanced).toBeGreaterThanOrEqual(1);

    const rows = await prisma.interaction.findMany({
      where: { clientId: c.id, nextAction: { in: [AUTO_THINKING_MARKER, SECOND_TIER_MARKER] } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[1].nextAction).toBe(SECOND_TIER_MARKER);
    expect(rows[1].completedAt).toBeNull();
  });

  it("повторный тик без новых просрочек — не плодит вторую задачу шага 2 (дедуп)", async () => {
    const c = await makeClient();
    await makeOverdueTask(c.id, AUTO_THINKING_MARKER);
    await runBuyerThinkingSlowTrackTick();
    await runBuyerThinkingSlowTrackTick();

    const rows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: SECOND_TIER_MARKER } });
    expect(rows).toHaveLength(1);
  });

  it("клиент потерян (LOST) — задача закрывается, шаг 2 не заводится", async () => {
    const c = await makeClient();
    await prisma.client.update({ where: { id: c.id }, data: { status: "LOST" } });
    await makeOverdueTask(c.id, AUTO_THINKING_MARKER);

    await runBuyerThinkingSlowTrackTick();

    const rows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: { not: null } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].completedAt).not.toBeNull();
  });

  it("агент записал свежий «Итог показа» после заведения задачи — трек останавливается", async () => {
    const c = await makeClient();
    await makeOverdueTask(c.id, AUTO_THINKING_MARKER);
    // Свежий MEETING ПОСЛЕ создания задачи (не до) — именно это тормозит трек.
    await prisma.interaction.create({
      data: { clientId: c.id, agentId, type: "MEETING", notes: "Итог показа: тест" },
    });

    await runBuyerThinkingSlowTrackTick();

    const rows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: SECOND_TIER_MARKER } });
    expect(rows).toHaveLength(0);
  });

  it("шаг 2 просрочен — продвигает на медленный трек", async () => {
    const c = await makeClient();
    await makeOverdueTask(c.id, SECOND_TIER_MARKER);

    await runBuyerThinkingSlowTrackTick();

    const rows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: SLOW_TRACK_MARKER } });
    expect(rows).toHaveLength(1);
  });

  it("медленный трек просрочен — продлевает сам себя (renew)", async () => {
    const c = await makeClient();
    await makeOverdueTask(c.id, SLOW_TRACK_MARKER);

    await runBuyerThinkingSlowTrackTick();

    const rows = await prisma.interaction.findMany({
      where: { clientId: c.id, nextAction: SLOW_TRACK_MARKER },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[1].completedAt).toBeNull();
  });

  it("отработал buyerThinkingSlowTrackCycles еженедельных циклов — переходит на финальный темп buyerThinkingFinalTrackDays", async () => {
    const c = await makeClient();
    // Настроено на cycles=2: один цикл уже закрыт раньше, сейчас просрочен второй —
    // после него completedCycles достигнет 2 и трек должен переключиться на финал.
    await makeCompletedSlowTrackCycle(c.id);
    await makeOverdueTask(c.id, SLOW_TRACK_MARKER);

    await runBuyerThinkingSlowTrackTick();

    const finalRows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: FINAL_TRACK_MARKER } });
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].completedAt).toBeNull();

    // Срок — buyerThinkingFinalTrackDays (10 дней в тесте), а не buyerThinkingSlowTrackDays (7 по дефолту).
    const expectedMs = 10 * 86_400_000;
    const actualMs = finalRows[0].nextActionDate!.getTime() - Date.now();
    expect(actualMs).toBeGreaterThan(expectedMs - 5 * 60_000);
    expect(actualMs).toBeLessThan(expectedMs + 5 * 60_000);

    // Больше не заводится новая задача медленного (еженедельного) трека для этого клиента.
    const stillWeeklyOpen = await prisma.interaction.findFirst({
      where: { clientId: c.id, nextAction: SLOW_TRACK_MARKER, completedAt: null },
    });
    expect(stillWeeklyOpen).toBeNull();
  });

  it("на финальном темпе — продлевает сам себя тем же buyerThinkingFinalTrackDays и не откатывается на еженедельный", async () => {
    const c = await makeClient();
    await makeCompletedSlowTrackCycle(c.id);
    await makeOverdueTask(c.id, SLOW_TRACK_MARKER);
    await runBuyerThinkingSlowTrackTick(); // переход на FINAL_TRACK_MARKER (проверено тестом выше)

    // Ещё один просроченный шаг уже на финальном темпе.
    await prisma.interaction.updateMany({
      where: { clientId: c.id, nextAction: FINAL_TRACK_MARKER, completedAt: null },
      data: { nextActionDate: new Date(Date.now() - 3600_000) },
    });
    await runBuyerThinkingSlowTrackTick();

    const finalRows = await prisma.interaction.findMany({
      where: { clientId: c.id, nextAction: FINAL_TRACK_MARKER },
      orderBy: { createdAt: "asc" },
    });
    expect(finalRows).toHaveLength(2);
    expect(finalRows[0].completedAt).not.toBeNull();
    expect(finalRows[1].completedAt).toBeNull();

    const expectedMs = 10 * 86_400_000;
    const actualMs = finalRows[1].nextActionDate!.getTime() - Date.now();
    expect(actualMs).toBeGreaterThan(expectedMs - 5 * 60_000);
    expect(actualMs).toBeLessThan(expectedMs + 5 * 60_000);

    // Никакой НОВОЙ SLOW_TRACK_MARKER задачи не заводится — переход необратим.
    // Две существующие — ручной «уже отработанный» цикл + просроченная задача,
    // которую тик закрыл при переходе на FINAL_TRACK_MARKER; обе уже completedAt.
    const weeklyRows = await prisma.interaction.findMany({ where: { clientId: c.id, nextAction: SLOW_TRACK_MARKER } });
    expect(weeklyRows).toHaveLength(2);
    expect(weeklyRows.every((r) => r.completedAt !== null)).toBe(true);
  });
});
