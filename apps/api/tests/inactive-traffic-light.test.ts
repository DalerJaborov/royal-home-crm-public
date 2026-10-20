import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { classifyInactiveLevelByDepth } from "../src/lib/inactiveTrafficLight.js";
import { deactivateClient } from "../src/lib/clientWorkStatus.js";

/**
 * Светофор неактивных (мозговой штурм 21.08.2026, цвет переделан на глубину
 * истории 03.09.2026). Правила этого файла:
 *  1) цвет вычисляется по ИСТОРИИ клиента (дозвонились? была встреча?), а не
 *     по причине и не по выбору агента (classifyInactiveLevelByDepth);
 *  2) перевести в Неактивные с ЛЮБОЙ причиной без достаточного числа
 *     зафиксированных попыток контакта НЕЛЬЗЯ — 409, а не тихий успех;
 *  3) агент, только что переведший клиента в Неактивные, на inactivateCooldownHours
 *     выпадает из очереди раздачи новых лидов.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
const clientIds: string[] = [];

async function makeBuyer(overrides: Partial<{ acceptedAt: Date }> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Покупатель светофора ${runId}-${clientIds.length}`,
      phone: `+992907${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      assignedAgentId: agentId,
      acceptedAt: overrides.acceptedAt ?? new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-светофор-${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: "Агент светофора", phone: `+992963${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.delete({ where: { id: agentId } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("классификация цвета — по глубине истории, не по причине", () => {
  it("ни разу не дозвонились — красный, независимо от причины", async () => {
    const client = await makeBuyer();
    await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "Не поднял" },
    });
    expect(await classifyInactiveLevelByDepth(client.id, "BUYER", 30)).toBe("RED");
  });

  it("дозвонились, но встречи не было — жёлтый, даже с причиной «перестал отвечать»", async () => {
    const client = await makeBuyer();
    await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "CALL", recordingDurationSec: 60, notes: "Разговор" },
    });
    expect(await classifyInactiveLevelByDepth(client.id, "BUYER", 30)).toBe("YELLOW");
  });

  it("был показ — зелёный, покупатель", async () => {
    const client = await makeBuyer();
    await prisma.interaction.create({
      data: { clientId: client.id, agentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });
    expect(await classifyInactiveLevelByDepth(client.id, "BUYER", 30)).toBe("GREEN");
  });

  it("была встреча на объекте — зелёный, продавец", async () => {
    const client = await makeBuyer(); // kind не важен для этого клиента-фикстуры, встреча решает
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "MEETING",
        outcome: "SELLER_MEETING",
        notes: "Встреча на объекте",
        completedAt: new Date(),
      },
    });
    expect(await classifyInactiveLevelByDepth(client.id, "SELLER", 30)).toBe("GREEN");
  });
});

describe("гейт «след работы» перед переводом в Неактивные", () => {
  it("STOPPED_RESPONDING без единой попытки контакта — гейт отказывает, клиент остаётся ACTIVE", async () => {
    const client = await makeBuyer();
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "Двухкомнатная в центре",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/попытк/i);

    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true, inactiveLevel: true } });
    expect(after?.workStatus).toBe("ACTIVE");
    expect(after?.inactiveLevel).toBeNull();
  });

  it("THINKING без попыток контакта отказывает (владелец 03.09: след работы нужен для любой причины)", async () => {
    const client = await makeBuyer();
    const blocked = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "THINKING",
      initiator: "CLIENT",
      actualNeeds: "Думает над предложением",
    });
    expect(blocked.ok).toBe(false);
    await prisma.interaction.createMany({ data: [1, 2].map((n) => ({ clientId: client.id, agentId, type: "CALL" as const, callAttempt: "NO_ANSWER" as const, notes: `попытка ${n}` })) });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "THINKING",
      initiator: "CLIENT",
      actualNeeds: "Думает над предложением",
    });
    expect(result.ok).toBe(true);

    const after = await prisma.client.findUnique({
      where: { id: client.id },
      select: { workStatus: true, inactiveLevel: true, inactiveReasonKey: true, inactiveSince: true, inactivePingCount: true },
    });
    expect(after?.workStatus).toBe("INACTIVE");
    // Цвет — по глубине истории, не по причине (владелец 03.09): два недозвона
    // без разговора и без встречи — красный, даже с открытой причиной THINKING.
    expect(after?.inactiveLevel).toBe("RED");
    expect(after?.inactiveReasonKey).toBe("THINKING");
    expect(after?.inactiveSince).not.toBeNull();
    expect(after?.inactivePingCount).toBe(0);
  });

  it("STOPPED_RESPONDING после двух реальных звонков — проходит", async () => {
    const client = await makeBuyer();
    // Два «состоявшихся» звонка — длиннее leadCallMinSeconds по умолчанию (30 с).
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", recordingDurationSec: 60, notes: "Звонок 1" },
        { clientId: client.id, agentId, type: "CALL", recordingDurationSec: 90, notes: "Звонок 2" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "Искал трёхкомнатную",
    });
    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true, inactiveLevel: true } });
    expect(after?.workStatus).toBe("INACTIVE");
    // Цвет — по глубине истории (владелец 03.09): два состоявшихся разговора без
    // встречи дают жёлтый, даже с причиной STOPPED_RESPONDING (которая раньше
    // всегда красила в красный сама по себе).
    expect(after?.inactiveLevel).toBe("YELLOW");
  });

  it("звонки без разметки станции и без исхода в счёт не идут", async () => {
    const client = await makeBuyer();
    // Ни callAttempt (станция такого не писала), ни outcome (агент не отчитался) —
    // о таких записях нельзя сказать, что кто-то с кем-то связывался.
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", recordingDurationSec: null, notes: "Не поднял" },
        { clientId: client.id, agentId, type: "CALL", recordingDurationSec: null, notes: "Сброс" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "Не берёт трубку",
    });
    expect(result.ok).toBe(false);
  });

  /**
   * ГЛАВНОЕ ИЗМЕНЕНИЕ 27.08.2026. До него гейт требовал двух РАЗГОВОРОВ дольше
   * тридцати секунд — у молчащего клиента их не бывает по определению, и карточку
   * с причиной «перестал отвечать» нельзя было закрыть никогда. На проде так
   * заперло 39 активных карточек из 52.
   */
  it("два недозвона через CRM — попытки засчитаны, перевод проходит", async () => {
    const client = await makeBuyer();
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "Звонок через CRM: клиент не ответил" },
        { clientId: client.id, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "Звонок через CRM: клиент не ответил" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "Не берёт трубку неделю",
    });
    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { workStatus: true, inactiveLevel: true } });
    expect(after?.workStatus).toBe("INACTIVE");
    expect(after?.inactiveLevel).toBe("RED");
  });

  it("короткий разговор (11 секунд) — это контакт, а не пустое место", async () => {
    const client = await makeBuyer();
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", callAttempt: "TALKED", recordingDurationSec: 11, notes: "Звонок через CRM, разговор 0:11" },
        { clientId: client.id, agentId, type: "CALL", callAttempt: "NO_ANSWER", notes: "Звонок через CRM: клиент не ответил" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "OTHER",
      initiator: "CLIENT",
      actualNeeds: "Просил не звонить",
    });
    expect(result.ok).toBe(true);
  });

  it("«агент не снял трубку» попыткой не считается — телефон клиента не звонил", async () => {
    const client = await makeBuyer();
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", callAttempt: "AGENT_NO_PICKUP", notes: "Звонок через CRM не состоялся: агент не снял трубку, клиенту не звонили" },
        { clientId: client.id, agentId, type: "CALL", callAttempt: "AGENT_NO_PICKUP", notes: "Звонок через CRM не состоялся: агент не снял трубку, клиенту не звонили" },
        { clientId: client.id, agentId, type: "CALL", callAttempt: "CANCELLED", notes: "Звонок через CRM отменён агентом — телефон клиента уже звонил" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "—",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/сейчас 0/);
  });

  it("ручные записи о звонке с исходом — засчитываются: исход без разговора не узнать", async () => {
    const client = await makeBuyer();
    await prisma.interaction.createMany({
      data: [
        { clientId: client.id, agentId, type: "CALL", outcome: "WAITING_CALL", notes: "Разговор с клиентом, записан агентом вручную" },
        { clientId: client.id, agentId, type: "CALL", outcome: "NEUTRAL", notes: "Разговор с клиентом, записан агентом вручную" },
      ],
    });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "STOPPED_RESPONDING",
      initiator: "CLIENT",
      actualNeeds: "Перестал отвечать после двух разговоров",
    });
    expect(result.ok).toBe(true);
  });
});

describe("cooldown после слива", () => {
  it("агент, только что деактивировавший клиента, не получает новый лид от pickAgentForLead", async () => {
    const client = await makeBuyer();
    await prisma.interaction.createMany({ data: [1, 2].map((n) => ({ clientId: client.id, agentId, type: "CALL" as const, callAttempt: "NO_ANSWER" as const, notes: `попытка ${n}` })) });
    const result = await deactivateClient({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      reason: "THINKING",
      initiator: "CLIENT",
      actualNeeds: "—",
    });
    expect(result.ok).toBe(true);

    const { agentsInCooldown } = await import("../src/lib/inactiveTrafficLight.js");
    const cooling = await agentsInCooldown([agentId]);
    expect(cooling.has(agentId)).toBe(true);
  });
});
