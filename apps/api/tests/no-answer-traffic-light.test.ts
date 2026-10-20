import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { checkNoAnswerStreakForTrafficLight } from "../src/lib/noAnswerTrafficLight.js";
import { applyStationDialResult, finishCall, resetCalls, trackCall } from "../src/lib/telephony/callTracker.js";

/**
 * Раздел C плана 19-plan-03-09-evening.md: «3 недозвона подряд» без единого
 * TALKED между ними должны автоматически перевести клиента в светофор неактивных
 * (deactivateClient), а не только в косметический ClientStatus.UNRESPONSIVE
 * (lib/clientAutoStatus.ts, уже существовало) или эскалацию руководителю
 * (lib/noAnswerStreak.ts, уже существовало).
 *
 * Первый блок — прямые тесты checkNoAnswerStreakForTrafficLight на подготовленных
 * записях Interaction (без телефонии — быстро и точно проверяет саму логику счёта
 * и гейта). Второй блок — через настоящий lib/telephony/callTracker.ts::finishCall,
 * чтобы убедиться, что хук в реальном пути (АТС → finishCall → callAttempt=NO_ANSWER)
 * действительно подключён, а не только сама функция работает в изоляции.
 */

const runId = Date.now();
let n = 0;
const agentIds: string[] = [];
const clientIds: string[] = [];

async function makeAgent() {
  const a = await prisma.agent.create({
    data: { fullName: `Агент недозвона ${runId}-${n}`, phone: `+992900${runId}${n++}`, role: "AGENT", passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

async function makeClient(agentId: string, overrides: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент недозвона ${runId}-${n}`,
      phone: `+992901${runId}${n++}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Запись CALL-звонка напрямую, без телефонии — для точечных тестов самого счётчика. */
async function makeCall(clientId: string, agentId: string, callAttempt: string) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes: "тест", callAttempt },
  });
}

afterEach(async () => {
  resetCalls();
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  clientIds.length = 0;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("checkNoAnswerStreakForTrafficLight — прямая проверка счётчика и гейта", () => {
  it("3 недозвона подряд (callAttempt=NO_ANSWER) переводят клиента в Неактивные", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id);
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { workStatus: true, inactiveReasonKey: true, inactiveLevel: true },
    });
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.inactiveReasonKey).toBe("OTHER");
    // Ни разу не дозвонились и встречи не было — по глубине истории это RED
    // (classifyInactiveLevelByDepth, lib/inactiveTrafficLight.ts).
    expect(after?.inactiveLevel).toBe("RED");

    const note = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "Неактивные" } },
    });
    expect(note, "нет записи в хронологии о переводе").toBeTruthy();
  });

  it("TALKED среди последних трёх звонков — серия сброшена, клиент остаётся ACTIVE", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id);
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "TALKED");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("только 2 недозвона — рано, клиент остаётся ACTIVE", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id);
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("клиент уже Неактивен — повторно не переводит и не пишет вторую запись", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id, {
      workStatus: "INACTIVE",
      inactiveLevel: "RED",
      inactiveSince: new Date(),
      inactivePingCount: 0,
      inactiveReasonKey: "OTHER",
    });
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const notes = await prisma.interaction.count({
      where: { clientId: client.id, type: "SYSTEM", notes: { contains: "Неактивные" } },
    });
    expect(notes).toBe(0);
  });

  it("недозвон без назначенного агента — тихо ничего не делает (некому назначить деактивацию)", async () => {
    const client = await makeClient((await makeAgent()).id);
    await prisma.client.update({ where: { id: client.id }, data: { assignedAgentId: null } });
    const agent = await makeAgent();
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await expect(checkNoAnswerStreakForTrafficLight(client.id)).resolves.toBeUndefined();
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  /**
   * НАЙДЕНО 18.09.2026 (владелец: «сделай логичным, без таких ошибок»): счётчик
   * выше смотрит только на звонки и не видел, что клиент прямо сейчас пишет сам —
   * «не отвечает по телефону» и «неактивен» разные вопросы, а гейт
   * canDeactivateWithReason от этого не защищает (требует попыток когда-либо,
   * не отсутствия ответа прямо сейчас).
   */
  it("клиент писал сам недавно — 3 недозвона НЕ переводят в Неактивные", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id, { lastClientMessageAt: new Date(Date.now() - 60 * 60 * 1000) });
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });

  it("клиент писал давно (за пределами грейса) — 3 недозвона переводят как обычно", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id, {
      lastClientMessageAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");
    await makeCall(client.id, agent.id, "NO_ANSWER");

    await checkNoAnswerStreakForTrafficLight(client.id);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("INACTIVE");
  });
});

describe("Хук в lib/telephony/callTracker.ts::finishCall — реальный путь недозвона", () => {
  async function startedInteraction(clientId: string, agentId: string) {
    return prisma.interaction.create({
      data: { clientId, agentId, type: "CALL", notes: "Звонок инициирован из CRM" },
    });
  }

  /** Один недозвон через телефонию: станция дозвонилась до клиента (DIALSTATUS
   *  NOANSWER — клиент не поднял трубку), ровно как в реальном finishCall. */
  async function noAnswerCall(clientId: string, agentId: string, clientName: string, channelId: string) {
    const interaction = await startedInteraction(clientId, agentId);
    trackCall({
      channelId,
      agentId,
      clientId,
      clientName,
      dialingTo: "900000000",
      clientPhone: "+992900000000",
      interactionId: interaction.id,
    });
    applyStationDialResult(channelId, { status: "NOANSWER", answeredSeconds: null });
    await finishCall(channelId);
  }

  async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > until) throw new Error("не дождались условия");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("3 подряд недозвона через CRM-телефонию переводят клиента в Неактивные (OTHER)", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id);

    await noAnswerCall(client.id, agent.id, client.fullName, `no-answer-${runId}-1`);
    await noAnswerCall(client.id, agent.id, client.fullName, `no-answer-${runId}-2`);
    await noAnswerCall(client.id, agent.id, client.fullName, `no-answer-${runId}-3`);

    const after = await waitFor(async () => {
      const c = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true, inactiveReasonKey: true } });
      return c?.workStatus === "INACTIVE" ? c : null;
    });
    expect(after.inactiveReasonKey).toBe("OTHER");
  });

  it("2 недозвона через CRM — рано, клиент остаётся ACTIVE", async () => {
    const agent = await makeAgent();
    const client = await makeClient(agent.id);

    await noAnswerCall(client.id, agent.id, client.fullName, `no-answer-${runId}-4`);
    await noAnswerCall(client.id, agent.id, client.fullName, `no-answer-${runId}-5`);

    // Даём фоновой (void) проверке шанс отработать — и убеждаемся, что она НЕ
    // перевела клиента, а не просто «ещё не успела».
    await new Promise((r) => setTimeout(r, 500));
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true } });
    expect(after?.workStatus).toBe("ACTIVE");
  });
});
