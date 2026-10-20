import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

const checkClientExplainedPause = vi.fn();
vi.mock("../src/ai/offCrmPauseCheck.js", () => ({ checkClientExplainedPause }));

const { prisma } = await import("../src/db.js");
const { runAgentOffCrmAlarmTick, OFF_CRM_SILENCE_DAYS } = await import("../src/lib/agentOffCrmAlarm.js");

/**
 * Аларм «агент, похоже, увёл клиента в обход CRM» (владелец 07.09.2026).
 * Триггер: спросил номер (Client.phoneAskFlaggedAt) + после этого тишина
 * (lastContactAt) или брошенная встреча/показ — но только если сам клиент не
 * объяснил паузу (мокаем ai/offCrmPauseCheck.ts).
 */

const runId = Date.now();
const NOW = new Date("2026-09-01T07:00:00Z"); // рабочие часы, вторник
const DAY_MS = 86_400_000;
const password = "testpass123";

let districtId: string;
let agentId: string;
let directorId: string;
const clientIds: string[] = [];
const interactionIds: string[] = [];

async function makeClient(opts: {
  phoneAskFlaggedAt?: Date | null;
  lastContactAt?: Date;
  offCrmAlarmNotifiedAt?: Date | null;
}) {
  const idx = clientIds.length;
  const c = await prisma.client.create({
    data: {
      fullName: `В обход CRM ${runId}-${idx}`,
      phone: `+992920${runId}${idx}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      workStatus: "ACTIVE",
      status: "NEW",
      assignedAgentId: agentId,
      phoneAskFlaggedAt: opts.phoneAskFlaggedAt ?? null,
      phoneAskFlaggedByAgentId: opts.phoneAskFlaggedAt ? agentId : null,
      lastContactAt: opts.lastContactAt ?? NOW,
      offCrmAlarmNotifiedAt: opts.offCrmAlarmNotifiedAt ?? null,
    },
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-в-обход-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент в обход CRM", phone: `+992921${runId}0`, role: "AGENT", passwordHash } })
  ).id;
  directorId = (
    await prisma.agent.create({ data: { fullName: "Директор в обход CRM", phone: `+992921${runId}1`, role: "DIRECTOR", passwordHash } })
  ).id;
});

beforeEach(() => {
  checkClientExplainedPause.mockReset();
  checkClientExplainedPause.mockResolvedValue({ explained: false });
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "agent-off-crm-" } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.delete({ where: { id: districtId } });
});

describe("runAgentOffCrmAlarmTick", () => {
  it("спросил номер, тишина 2+ дня, клиент паузу не объяснил → аларм", async () => {
    const c = await makeClient({
      phoneAskFlaggedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      lastContactAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
    });

    const { alerted } = await runAgentOffCrmAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    expect(checkClientExplainedPause).toHaveBeenCalledWith(c.id);

    const note = await prisma.notification.findFirst({ where: { tag: `agent-off-crm-${c.id}` } });
    expect(note).not.toBeNull();

    const updated = await prisma.client.findUnique({ where: { id: c.id } });
    expect(updated?.offCrmAlarmNotifiedAt).not.toBeNull();
  });

  it("спросил номер, но контакт был недавно → аларма нет, ИИ не вызывается", async () => {
    await makeClient({
      phoneAskFlaggedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      lastContactAt: NOW,
    });
    await runAgentOffCrmAlarmTick(NOW);
    expect(checkClientExplainedPause).not.toHaveBeenCalled();
  });

  it("номер не спрашивали вовсе → клиент не попадает в кандидаты", async () => {
    await makeClient({ phoneAskFlaggedAt: null, lastContactAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    await runAgentOffCrmAlarmTick(NOW);
    expect(checkClientExplainedPause).not.toHaveBeenCalled();
  });

  it("клиент сам объяснил паузу (ИИ вернул explained=true) → аларма нет, но случай отмечен как разобранный", async () => {
    checkClientExplainedPause.mockResolvedValue({ explained: true, reason: "уехал в отпуск" });
    const c = await makeClient({
      phoneAskFlaggedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      lastContactAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
    });

    const { alerted, skipped } = await runAgentOffCrmAlarmTick(NOW);
    expect(alerted).toBe(0);
    expect(skipped).toBeGreaterThanOrEqual(1);

    const note = await prisma.notification.findFirst({ where: { tag: `agent-off-crm-${c.id}` } });
    expect(note).toBeNull();

    const updated = await prisma.client.findUnique({ where: { id: c.id } });
    expect(updated?.offCrmAlarmNotifiedAt).not.toBeNull();
  });

  it("случай уже разобран (offCrmAlarmNotifiedAt свежее флага) → повторно не проверяется", async () => {
    const flaggedAt = new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS);
    await makeClient({
      phoneAskFlaggedAt: flaggedAt,
      lastContactAt: flaggedAt,
      offCrmAlarmNotifiedAt: new Date(flaggedAt.getTime() + 60 * 60 * 1000),
    });
    await runAgentOffCrmAlarmTick(NOW);
    expect(checkClientExplainedPause).not.toHaveBeenCalled();
  });

  it("новый (более поздний) вопрос про номер снова открывает проверку", async () => {
    const oldFlag = new Date(NOW.getTime() - 10 * DAY_MS);
    const c = await makeClient({
      phoneAskFlaggedAt: oldFlag,
      lastContactAt: oldFlag,
      offCrmAlarmNotifiedAt: new Date(oldFlag.getTime() + 60 * 60 * 1000),
    });
    // Повторный вопрос про номер, свежее прежней отметки «разобрано».
    const newFlag = new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS);
    await prisma.client.update({
      where: { id: c.id },
      data: { phoneAskFlaggedAt: newFlag, lastContactAt: newFlag },
    });

    await runAgentOffCrmAlarmTick(NOW);
    expect(checkClientExplainedPause).toHaveBeenCalledWith(c.id);
  });

  it("брошенная встреча (просрочена, не закрыта, не отменена) без тишины → аларм", async () => {
    const c = await makeClient({
      phoneAskFlaggedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      lastContactAt: NOW, // контакт свежий — сама по себе тишина не триггерит
    });
    const interaction = await prisma.interaction.create({
      data: {
        clientId: c.id,
        agentId,
        type: "SHOWING",
        notes: "Показ назначен",
        nextAction: "Показ квартиры",
        nextActionDate: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
        completedAt: null,
        declinedAt: null,
      },
    });
    interactionIds.push(interaction.id);

    const { alerted } = await runAgentOffCrmAlarmTick(NOW);
    expect(alerted).toBeGreaterThanOrEqual(1);
    expect(checkClientExplainedPause).toHaveBeenCalledWith(c.id);
  });

  it("встреча отменена клиентом (declinedAt) → не считается брошенной, аларма нет", async () => {
    await makeClient({
      phoneAskFlaggedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      lastContactAt: NOW,
    });
    const c2 = clientIds[clientIds.length - 1];
    const interaction = await prisma.interaction.create({
      data: {
        clientId: c2,
        agentId,
        type: "SHOWING",
        notes: "Показ отменён клиентом",
        nextAction: "Показ квартиры",
        nextActionDate: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
        completedAt: null,
        declinedAt: new Date(NOW.getTime() - (OFF_CRM_SILENCE_DAYS + 1) * DAY_MS),
      },
    });
    interactionIds.push(interaction.id);

    await runAgentOffCrmAlarmTick(NOW);
    expect(checkClientExplainedPause).not.toHaveBeenCalled();
  });
});
