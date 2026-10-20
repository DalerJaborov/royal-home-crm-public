import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { pickAgentForLead } from "../src/leads.js";
import { agentsOnShowingOrCall, agentsWithUncalledAcceptedLead } from "../src/lib/agentOccupancyShield.js";
import { trackCall, resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * Щиток занятости в раздаче (мозговой штурм 20-21.08.2026, «рубеж 1: вход») —
 * вероятный корень случая 18.08.2026 с Нурмухаммадом: агент на показе или в
 * разговоре не должен получать новый лид с тикающим таймером посреди работы.
 * См. lib/agentOccupancyShield.ts.
 */

const runId = Date.now();

let busyAgentId: string;
let freeAgentId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];
let savedShieldEnabled: boolean | null = null;
let savedShieldAfterMinutes: number | null = null;

async function makeShowingClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент щитка ${runId}-${clientIds.length}`,
      phone: `+9929${Math.floor(Math.random() * 10_000_000)}`,
      source: "PHONE_CALL",
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Показ, ещё не отмеченный ни выполненным, ни отменённым. */
async function scheduleActiveShowing(agentId: string, clientId: string, startedMinutesAgo: number) {
  const i = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "SHOWING",
      notes: "Показ назначен",
      nextAction: "Показ объекта",
      nextActionDate: new Date(Date.now() - startedMinutesAgo * 60_000),
    },
  });
  interactionIds.push(i.id);
  return i;
}

beforeAll(async () => {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { agentOccupancyShieldEnabled: true, agentOccupancyShieldAfterMinutes: true },
  });
  savedShieldEnabled = settings?.agentOccupancyShieldEnabled ?? true;
  savedShieldAfterMinutes = settings?.agentOccupancyShieldAfterMinutes ?? 30;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { agentOccupancyShieldEnabled: true, agentOccupancyShieldAfterMinutes: 30 },
  });

  const busy = await prisma.agent.create({
    data: { fullName: "Агент занятый", phone: `+992978${runId}`, role: "AGENT", passwordHash: "x" },
  });
  busyAgentId = busy.id;
  const free = await prisma.agent.create({
    data: { fullName: "Агент свободный щиток", phone: `+992979${runId}`, role: "AGENT", passwordHash: "x" },
  });
  freeAgentId = free.id;
});

afterEach(async () => {
  resetCalls();
  if (interactionIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
    interactionIds.length = 0;
  }
});

afterAll(async () => {
  if (savedShieldEnabled !== null) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        agentOccupancyShieldEnabled: savedShieldEnabled,
        agentOccupancyShieldAfterMinutes: savedShieldAfterMinutes ?? 30,
      },
    });
  }
  await prisma.interaction.deleteMany({ where: { agentId: { in: [busyAgentId, freeAgentId] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [busyAgentId, freeAgentId] } } });
  await prisma.$disconnect();
});

describe("щиток занятости — показ", () => {
  it("агент на показе (начался 10 мин назад из 30) не попадает в pickAgentForLead", async () => {
    const client = await makeShowingClient();
    await scheduleActiveShowing(busyAgentId, client.id, 10);

    // Исключаем всех посторонних агентов (сидов/соседних тестов), как и в
    // lead-active-limit.test.ts — иначе pickAgentForLead выбирал бы среди всей
    // базы, и слабый негатив («не busyAgentId») ничего бы не проверял всерьёз.
    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [busyAgentId, freeAgentId] } },
      select: { id: true },
    });
    for (let i = 0; i < 5; i++) {
      const picked = await pickAgentForLead(others.map((a) => a.id), "BUYER");
      expect(picked).toBe(freeAgentId);
    }
    // Прямая проверка функции — то, что реально проверяет предикат.
    const busySet = await agentsOnShowingOrCall([busyAgentId, freeAgentId]);
    expect(busySet.has(busyAgentId)).toBe(true);
    expect(busySet.has(freeAgentId)).toBe(false);
  });

  it("между свободным и занятым pickAgentForLead выбирает свободного", async () => {
    const client = await makeShowingClient();
    await scheduleActiveShowing(busyAgentId, client.id, 5);

    const picked = await pickAgentForLead(
      (await prisma.agent.findMany({ where: { role: "AGENT", isActive: true, id: { notIn: [busyAgentId, freeAgentId] } }, select: { id: true } })).map((a) => a.id)
    );
    expect(picked).toBe(freeAgentId);
  });

  it("показ старше agentOccupancyShieldAfterMinutes больше не считается занятостью", async () => {
    const client = await makeShowingClient();
    // 30 минут — граница по умолчанию; 40 минут назад — точно вне окна.
    await scheduleActiveShowing(busyAgentId, client.id, 40);

    const busySet = await agentsOnShowingOrCall([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(false);
  });

  it("отменённый показ (nextAction снят + declinedAt) занятостью не считается", async () => {
    const client = await makeShowingClient();
    const showing = await scheduleActiveShowing(busyAgentId, client.id, 10);
    await prisma.interaction.update({
      where: { id: showing.id },
      data: { nextAction: null, declinedAt: new Date() },
    });

    const busySet = await agentsOnShowingOrCall([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(false);
  });

  it("показ, отмеченный выполненным (completedAt), занятостью не считается", async () => {
    const client = await makeShowingClient();
    const showing = await scheduleActiveShowing(busyAgentId, client.id, 10);
    await prisma.interaction.update({ where: { id: showing.id }, data: { completedAt: new Date() } });

    const busySet = await agentsOnShowingOrCall([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(false);
  });
});

describe("щиток занятости — живой звонок через CRM", () => {
  it("агент с живым звонком (hasLiveCall) не попадает в pickAgentForLead", async () => {
    trackCall({
      channelId: `chan-${runId}`,
      agentId: busyAgentId,
      clientId: "не важен для hasLiveCall",
      clientShortId: 1,
      clientName: "Тест",
      dialingTo: "900000000",
    });

    const busySet = await agentsOnShowingOrCall([busyAgentId, freeAgentId]);
    expect(busySet.has(busyAgentId)).toBe(true);
    expect(busySet.has(freeAgentId)).toBe(false);

    const picked = await pickAgentForLead(
      (await prisma.agent.findMany({ where: { role: "AGENT", isActive: true, id: { notIn: [busyAgentId, freeAgentId] } }, select: { id: true } })).map((a) => a.id)
    );
    expect(picked).toBe(freeAgentId);
  });
});

describe("щиток занятости — выключатель", () => {
  it("agentOccupancyShieldEnabled=false — занятый агент участвует как обычно", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: false } });
    try {
      const client = await makeShowingClient();
      await scheduleActiveShowing(busyAgentId, client.id, 5);

      const busySet = await agentsOnShowingOrCall([busyAgentId]);
      expect(busySet.size).toBe(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: true } });
    }
  });

  it("если заняты ВСЕ кандидаты — щиток уступает, лид всё равно назначается", async () => {
    const client = await makeShowingClient();
    await scheduleActiveShowing(busyAgentId, client.id, 5);
    const client2 = await makeShowingClient();
    await scheduleActiveShowing(freeAgentId, client2.id, 5);

    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [busyAgentId, freeAgentId] } },
      select: { id: true },
    });
    const picked = await pickAgentForLead(others.map((a) => a.id));
    expect([busyAgentId, freeAgentId]).toContain(picked);
  });
});

/**
 * ТРЕТИЙ ПРИЗНАК — ПРИНЯЛ ЛИД, ЕЩЁ НЕ ПОЗВОНИЛ (14.09.2026, живая проверка
 * владельца: «принимаю лиды один за другим, второй приходит раньше, чем
 * успеваю позвонить первому»). См. agentsWithUncalledAcceptedLead.
 */
describe("щиток занятости — принял лид, ещё не позвонил", () => {
  let savedLeadCallMinutes: number | null = null;
  // Отдельный от внешнего clientIds список: клиенты этого блока обязаны
  // чиститься ПОСЛЕ КАЖДОГО теста, а не только в самом конце — иначе
  // «принятый, но ещё не позвонивший» клиент из одного теста утекает в
  // следующий и держит агента «занятым» там, где его быть не должно.
  const localClientIds: string[] = [];

  beforeAll(async () => {
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadCallMinutes: true } });
    savedLeadCallMinutes = s?.leadCallMinutes ?? 15;
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadCallMinutes: 15 } });
  });

  afterEach(async () => {
    if (localClientIds.length > 0) {
      await prisma.client.deleteMany({ where: { id: { in: localClientIds } } });
      localClientIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadCallMinutes: savedLeadCallMinutes ?? 15 } });
  });

  async function makeAcceptedClient(agentId: string, acceptedMinutesAgo: number) {
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент принят ${runId}-${localClientIds.length}`,
        phone: `+9928${Math.floor(Math.random() * 10_000_000)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        assignedAt: new Date(Date.now() - acceptedMinutesAgo * 60_000),
        acceptedAt: new Date(Date.now() - acceptedMinutesAgo * 60_000),
      },
    });
    localClientIds.push(c.id);
    return c;
  }

  it("принял лид 5 мин назад, ещё не звонил — не попадает в pickAgentForLead", async () => {
    await makeAcceptedClient(busyAgentId, 5);

    const busySet = await agentsWithUncalledAcceptedLead([busyAgentId, freeAgentId]);
    expect(busySet.has(busyAgentId)).toBe(true);
    expect(busySet.has(freeAgentId)).toBe(false);

    const others = await prisma.agent.findMany({
      where: { role: "AGENT", isActive: true, id: { notIn: [busyAgentId, freeAgentId] } },
      select: { id: true },
    });
    for (let i = 0; i < 5; i++) {
      const picked = await pickAgentForLead(others.map((a) => a.id), "BUYER");
      expect(picked).toBe(freeAgentId);
    }
  });

  it("позвонил (Interaction type=CALL после acceptedAt) — щиток снимается", async () => {
    const client = await makeAcceptedClient(busyAgentId, 5);
    const call = await prisma.interaction.create({
      data: { clientId: client.id, agentId: busyAgentId, type: "CALL", notes: "Позвонил" },
    });
    interactionIds.push(call.id);

    const busySet = await agentsWithUncalledAcceptedLead([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(false);
  });

  it("звонок ДО принятия (старый, из прошлого раза) обязанность не закрывает", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент старый звонок ${runId}`,
        phone: `+9928${Math.floor(Math.random() * 10_000_000)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: busyAgentId,
        assignedAt: new Date(Date.now() - 5 * 60_000),
        // Звонок был 20 минут назад, а принял клиента только что — старый
        // разговор из прошлого раза не должен закрывать сегодняшнюю обязанность.
        acceptedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    localClientIds.push(client.id);
    const call = await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId: busyAgentId,
        type: "CALL",
        notes: "Старый звонок",
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    interactionIds.push(call.id);

    const busySet = await agentsWithUncalledAcceptedLead([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(true);
  });

  it("входящий звонок клиента (IncomingCall) обязанность не закрывает", async () => {
    const client = await makeAcceptedClient(busyAgentId, 5);
    const call = await prisma.interaction.create({
      data: { clientId: client.id, agentId: busyAgentId, type: "CALL", notes: "Входящий" },
    });
    interactionIds.push(call.id);
    await prisma.incomingCall.create({
      data: { channelId: `in-${runId}-${call.id}`, phone: "+992900000000", clientId: client.id, interactionId: call.id },
    });

    const busySet = await agentsWithUncalledAcceptedLead([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(true);
  });

  it("окно leadCallMinutes истекло — щиток больше не держит (дальше решает firstCall.ts)", async () => {
    await makeAcceptedClient(busyAgentId, 20); // окно 15 минут

    const busySet = await agentsWithUncalledAcceptedLead([busyAgentId]);
    expect(busySet.has(busyAgentId)).toBe(false);
  });

  it("agentOccupancyShieldEnabled=false — не блокирует", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: false } });
    try {
      await makeAcceptedClient(busyAgentId, 5);
      const busySet = await agentsWithUncalledAcceptedLead([busyAgentId]);
      expect(busySet.size).toBe(0);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { agentOccupancyShieldEnabled: true } });
    }
  });
});
