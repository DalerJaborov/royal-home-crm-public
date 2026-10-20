import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Гейт «напоминания только в рабочие часы» (01.09.2026): notifyMissedShowings,
 * notifyOverdueTasks, notifyOverdueSummaries (штраф + пуш АГЕНТУ) молча
 * пропускают тик вне рабочих часов (Settings.workHoursStart/End) — не будят
 * агента ночью. sendHourBeforeReminders — исключение по плану («встреча есть
 * встреча независимо от времени суток») и здесь не проверяется.
 *
 * Пуш РУКОВОДСТВУ по этим же событиям (07.09.2026, разбор часов алармов) —
 * отдельные сборщики notifySupervisorsOfOverdue / notifySupervisorsOfOverdueSummaries,
 * со своим гейтом (Settings.alarmHours*, НЕ workHours*) и независимым от
 * агентской стороны дедупом (supervisorNotifiedAt).
 */

const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents, sendPushToAgent: sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { notifyMissedShowings, notifyOverdueTasks, notifySupervisorsOfOverdue } = await import(
  "../src/lib/meetingReminders.js"
);

const runId = Date.now();
let agentId: string;
let directorId: string;
let clientId: string;
const interactionIds: string[] = [];

// Момент вне рабочих часов Душанбе (03:00, UTC+5 => 22:00 UTC предыдущих суток),
// независимо от того, когда реально запущен тест.
const NIGHT_UTC = new Date(Date.UTC(2026, 0, 15, 22, 0, 0));
// Рабочий момент, точно в часах алармов (9:50-14:45 Душанбе по умолчанию):
// 07:00 UTC = 12:00 Душанбе, вторник.
const ALARM_HOURS_NOW = new Date("2026-09-01T07:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const NO_SHOW_AFTER_MS = 2 * HOUR_MS; // должно совпадать с NO_SHOW_AFTER_MS в meetingReminders.ts

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент часов", phone: `+992933${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  // Получатель сводки. Раньше файл его не заводил: sendPushToAgents был
  // подменён целиком, и вызов записывался в мок даже с пустым списком
  // получателей — проверка «сводка ушла» проходила бы и без единого
  // руководителя в базе. Теперь получатель настоящий.
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор часов", phone: `+992937${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент часов ${runId}`, phone: `+992932${runId}`, source: "PHONE_CALL", assignedAgentId: agentId },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("Вне рабочих часов — тихо пропускаем тик", () => {
  it("notifyMissedShowings возвращает 0 ночью, не трогая записи", async () => {
    await expect(notifyMissedShowings(NIGHT_UTC)).resolves.toBe(0);
  });

  it("notifyOverdueTasks возвращает 0 ночью", async () => {
    await expect(notifyOverdueTasks(NIGHT_UTC)).resolves.toBe(0);
  });

});

describe("Пуш руководству — отдельный гейт (часы алармов, не рабочие часы агента)", () => {
  it("notifySupervisorsOfOverdue: непроведённый показ — 0 вне часов алармов, доставляется в часы алармов", async () => {
    const interaction = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        notes: "Показ",
        nextAction: "Показ квартиры",
        nextActionDate: new Date(ALARM_HOURS_NOW.getTime() - NO_SHOW_AFTER_MS - HOUR_MS),
        completedAt: null,
      },
    });
    interactionIds.push(interaction.id);

    await expect(notifySupervisorsOfOverdue(NIGHT_UTC)).resolves.toBe(0);
    sendPushToAgents.mockClear();

    const notified = await notifySupervisorsOfOverdue(ALARM_HOURS_NOW);
    expect(notified).toBeGreaterThanOrEqual(1);
    // Владелец 20.09.2026: руководству — в ленту, без звонка телефона.
    const tag = "no-show-batch-" + ALARM_HOURS_NOW.getTime();
    expect(sendPushToAgents.mock.calls.some(([, payload]) => (payload as Record<string, string>).tag === tag)).toBe(
      false
    );
    const row = await prisma.notification.findFirst({ where: { agentId: directorId, tag } });
    expect(row, "сводка «Показ не отмечен» не попала в ленту руководителя").toBeTruthy();

    const updated = await prisma.interaction.findUnique({ where: { id: interaction.id } });
    expect(updated?.supervisorNotifiedAt).not.toBeNull();
  });

  it("notifySupervisorsOfOverdue: повторный сбор не шлёт дубль (supervisorNotifiedAt)", async () => {
    const interaction = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "MEETING",
        notes: "Встреча",
        nextAction: "Перезвонить",
        nextActionDate: new Date(ALARM_HOURS_NOW.getTime() - NO_SHOW_AFTER_MS - HOUR_MS),
        completedAt: null,
      },
    });
    interactionIds.push(interaction.id);

    await notifySupervisorsOfOverdue(ALARM_HOURS_NOW);
    sendPushToAgents.mockClear();
    await notifySupervisorsOfOverdue(new Date(ALARM_HOURS_NOW.getTime() + 5 * 60_000));

    const call = sendPushToAgents.mock.calls.find(
      ([, payload]) => typeof (payload as Record<string, string>).body === "string" && (payload as Record<string, string>).body.includes("Перезвонить")
    );
    expect(call).toBeUndefined();
  });

  it("не мешает агентской стороне: notifyMissedShowings/notifyOverdueTasks независимо штрафуют агента (пуша агенту больше нет)", async () => {
    const interaction = await prisma.interaction.create({
      data: {
        clientId,
        agentId,
        type: "SHOWING",
        notes: "Показ независимый",
        nextAction: "Показ квартиры",
        nextActionDate: new Date(ALARM_HOURS_NOW.getTime() - NO_SHOW_AFTER_MS - HOUR_MS),
        completedAt: null,
      },
    });
    interactionIds.push(interaction.id);

    const notified = await notifyMissedShowings(ALARM_HOURS_NOW);
    expect(notified).toBeGreaterThanOrEqual(1);
    const updated = await prisma.interaction.findUnique({ where: { id: interaction.id } });
    expect(updated?.noShowNotifiedAt).not.toBeNull();
    // Агентский тик не трогает supervisorNotifiedAt вовсе — это дело отдельного сборщика.
    expect(updated?.supervisorNotifiedAt).toBeNull();
  });
});
