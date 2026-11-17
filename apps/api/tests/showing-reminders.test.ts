import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));
// notifyMissedShowings/notifyOverdueTasks (агент) и notifySupervisorsOfOverdue
// (руководство, 07.09.2026 — отдельный гейт) не должны плавать в зависимости
// от времени суток запуска теста. sendHourBeforeReminders этот гейт намеренно
// не получил (встреча есть встреча независимо от времени суток) — мокать
// нечего, но и не мешает.
vi.mock("../src/lib/workingHours.js", () => ({
  isWithinWorkingHours: async () => true,
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { sendHourBeforeReminders, notifySupervisorsOfOverdue } = await import(
  "../src/lib/meetingReminders.js"
);

/** Ступени напоминаний: показ покупателя — за день, за 2 часа и за 40 минут
 *  (решение владельца 03.08 — объединили письменную спецификацию «день + час» с
 *  устным решением 30.07 про пробки, а не выбрали одно), встреча с собственником —
 *  за 2 часа и 40 минут при короткой записи («на завтра»), иначе за день и за час,
 *  прочие задачи — за час. Плюс контроль «показ не проведён». */

const runId = Date.now();
// Keep fixture dates and reminder ticks on the same explicit clock. At real
// 22:00 UTC, +120 minutes becomes the 00:00 "date without time" sentinel and
// three positive reminder cases fail. Minute 17 keeps every offset below away
// from that sentinel; real timers remain available to waitForSettled.
const NOW = new Date("2031-06-10T07:17:00.000Z");
let districtId: string;
let agentId: string;
let directorId: string;
let clientId: string;
let propertyId: string;
const taskIds: string[] = [];

/** Задача с временем через `minutesAhead` минут (отрицательное — в прошлом).
 *  `createdMinutesAgo` сдвигает `createdAt` назад — нужен только для MEETING:
 *  лестница выбирается по разнице между постановкой задачи и временем встречи. */
async function makeTask(
  type: "SHOWING" | "CALL" | "MEETING",
  minutesAhead: number,
  createdMinutesAgo = 0
) {
  const t = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type,
      propertyId: type === "SHOWING" ? propertyId : null,
      notes: `Задача ${type} ${runId}`,
      nextAction: type === "SHOWING" ? "Показ объекта" : type === "MEETING" ? "Встреча с собственником" : "Позвонить",
      nextActionDate: new Date(NOW.getTime() + minutesAhead * 60_000),
    },
  });
  if (createdMinutesAgo > 0) {
    await prisma.interaction.update({
      where: { id: t.id },
      data: { createdAt: new Date(NOW.getTime() - createdMinutesAgo * 60_000) },
    });
  }
  taskIds.push(t.id);
  return t;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-показ-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент показов", phone: `+992943${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор показов", phone: `+992942${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент показа ${runId}`,
        phone: `+992941${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект показа ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
      },
    })
  ).id;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Ступени напоминаний о показе", () => {
  it("за день не напоминает — на это есть вечерняя сводка «Завтра у вас N задач»", async () => {
    // Владелец 20.09.2026: «повторы вообще убери всем, пусть одного раза
    // достаточно». Ступень «за день» была первой из трёх по одному показу.
    await makeTask("SHOWING", 24 * 60);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("за 2 часа уходит единственное напоминание", async () => {
    const task = await makeTask("SHOWING", 120);
    expect(await sendHourBeforeReminders(NOW)).toBeGreaterThan(0);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("Через 2 часа");
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual(["2h"]);
  });

  it("автозадача системы (actorKind SYSTEM / autoTaskKind) напоминания не получает", async () => {
    const sys = await makeTask("SHOWING", 120);
    await prisma.interaction.update({ where: { id: sys.id }, data: { actorKind: "SYSTEM", agentId: null, subjectAgentId: agentId, autoTaskKind: "no_answer_retry" } });
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
    const after = await prisma.interaction.findUnique({ where: { id: sys.id } });
    expect(after?.remindersSent).toEqual([]);
  });

  it("повторный тик той же ступени не шлёт второй раз", async () => {
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("за 40 минут второго напоминания нет — повторы убраны (владелец 20.09.2026)", async () => {
    await makeTask("SHOWING", 40);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("часовой ступени у показа нет — три push подряд были бы шумом", async () => {
    await makeTask("SHOWING", 60);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("у обычной задачи ступень одна — за час", async () => {
    await makeTask("CALL", 60);
    await sendHourBeforeReminders(NOW);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("Через час");
  });

  it("у обычной задачи ступеней показа нет", async () => {
    await makeTask("CALL", 40);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});

describe("Ступени напоминаний о встрече с собственником", () => {
  it("встреча — одно напоминание за 2 часа", async () => {
    const task = await makeTask("MEETING", 120);
    expect(await sendHourBeforeReminders(NOW)).toBeGreaterThan(0);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("Через 2 часа");
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual(["2h"]);
  });

  it("сорока минут у встречи больше нет — одно напоминание на встречу", async () => {
    await makeTask("MEETING", 40);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("часовой ступени у короткой записи нет", async () => {
    await makeTask("MEETING", 60);
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });

  it("заранее поставленная встреча — та же единственная ступень за 2 часа", async () => {
    // createdAt отодвинут на 3 суток назад: раньше это выбирало другую лестницу
    // («день + час»). Развилки больше нет — ступень одна для любой встречи.
    const task = await makeTask("MEETING", 120, 3 * 24 * 60);
    expect(await sendHourBeforeReminders(NOW)).toBeGreaterThan(0);
    const [, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(payload.title).toContain("Через 2 часа");
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual(["2h"]);
  });

  it("ни «за день», ни «за час», ни «за 40 минут» у встречи больше нет", async () => {
    for (const minutes of [24 * 60, 60, 40]) {
      await makeTask("MEETING", minutes, 3 * 24 * 60);
    }
    await sendHourBeforeReminders(NOW);
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});

/**
 * ПЕРЕЗВОН ПОСЛЕ НЕДОЗВОНА напоминается В СРОК, а не заранее.
 *
 * Ступень стояла «за 15 минут», и перезвон назначается через те же 15 минут после
 * неудачного звонка — «за 15 минут до» наступало ровно в момент, когда агент положил
 * трубку. Он получал «Пора перезвонить» немедленно, а когда действительно приходило
 * время звонить — не получал ничего. Уведомление приходило, поэтому никто и не
 * замечал; поймано 14.08.2026 просьбой владельца «чтобы через 15 минут напомнило».
 */
async function makeNoAnswerCallback(minutesAhead: number) {
  const t = await prisma.interaction.create({
    data: {
      clientId,
      agentId,
      type: "CALL",
      outcome: "NO_ANSWER",
      notes: `Недозвон ${runId}-${minutesAhead}`,
      nextAction: "Перезвонить — клиент не ответил (попытка 1 из 3)",
      nextActionDate: new Date(NOW.getTime() + minutesAhead * 60_000),
    },
  });
  taskIds.push(t.id);
  return t;
}

describe("Напоминание перезвонить после недозвона", () => {
  it("сразу после недозвона не напоминает — звонить ещё рано", async () => {
    const task = await makeNoAnswerCallback(15);
    await sendHourBeforeReminders(NOW);
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual([]);
  });

  it("настало время перезвона — уходит «Пора перезвонить»", async () => {
    const task = await makeNoAnswerCallback(0);
    expect(await sendHourBeforeReminders(NOW)).toBeGreaterThan(0);
    const calls = sendPushToAgent.mock.calls as unknown as [string, Record<string, string>][];
    const payload = calls.map(([, p]) => p).find((p) => p.title.includes("Пора перезвонить"));
    expect(payload).toBeDefined();
    expect(payload!.title).toContain("Перезвонить");
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual(["due"]);
  });

  it("ступеней показа у перезвона нет — лишний шум агенту не нужен", async () => {
    const task = await makeNoAnswerCallback(120);
    await sendHourBeforeReminders(NOW);
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.remindersSent).toEqual([]);
  });
});

describe("Непроведённый показ", () => {
  it("через два часа после назначенного времени уходит руководству", async () => {
    // Агентская сторона (notifyMissedShowings — штраф showing_missed) удалена
    // 16.11.2026 вместе с автоматическими штрафами; руководству — сборщиком ниже.
    const task = await makeTask("SHOWING", -150);
    /**
     * РУКОВОДСТВУ — В КОЛОКОЛЬЧИК, БЕЗ ЗВОНКА ТЕЛЕФОНА (владелец 20.09.2026:
     * «эскалация убрать, то есть прямо таки пуш не нужно»). Проверяем оба
     * условия: строка в ленте у директора есть, push при этом не отправлялся.
     */
    sendPushToAgent.mockClear();
    expect(await notifySupervisorsOfOverdue(NOW)).toBe(1);
    const recipients = (sendPushToAgent.mock.calls as unknown as [string | string[], unknown][]).flatMap(([to]) =>
      Array.isArray(to) ? to : [to]
    );
    expect(recipients, "руководству по этому поводу телефон звонить не должен").not.toContain(directorId);
    const feedRow = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: { startsWith: "no-show-batch-" } },
    });
    expect(feedRow, "строка «Показ не отмечен» не попала в ленту руководителя").toBeTruthy();
    expect(feedRow!.title).toContain("Показ не отмечен");
    const afterSupervisor = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(afterSupervisor?.supervisorNotifiedAt).not.toBeNull();
  });

  it("второй раз о том же показе не сообщает", async () => {
    expect(await notifySupervisorsOfOverdue(NOW)).toBe(0);
  });

  it("отмеченный выполненным показ руководство не беспокоит", async () => {
    const task = await makeTask("SHOWING", -150);
    await prisma.interaction.update({ where: { id: task.id }, data: { completedAt: new Date() } });
    expect(await notifySupervisorsOfOverdue(NOW)).toBe(0);
  });

  it("показ, время которого ещё не прошло, не считается сорванным", async () => {
    await makeTask("SHOWING", -30);
    expect(await notifySupervisorsOfOverdue(NOW)).toBe(0);
  });
});

describe("Просроченные встречи и задачи, никогда не закрытые", () => {
  it("просроченная встреча — руководству сводки в ленте нет, отметка ставится", async () => {
    const task = await makeTask("MEETING", -150);

    /**
     * ОДИН PUSH ЗА ТИК, А НЕ ПО ОДНОМУ НА КАЖДУЮ ПРОСРОЧКУ (правка 30.08.2026,
     * коммит 312891c2 «один push за тик вместо залпа») — теперь отдельным
     * сборщиком notifySupervisorsOfOverdue (07.09.2026, часы алармов), не
     * отсюда. Руководителю уходит сводка с тегом `overdue-batch-<время тика>`.
     */
    sendPushToAgent.mockClear();
    expect(await notifySupervisorsOfOverdue(NOW)).toBeGreaterThan(0);
    // Сводка руководству — только в ленту, без push (владелец 20.09.2026).
    expect(
      sendPushToAgent.mock.calls.some(([, payload]) =>
        String((payload as Record<string, string>).tag ?? "").startsWith("overdue-batch-")
      )
    ).toBe(false);
    // Сводка «Просрочено: N» руководству убрана (владелец 02.10.2026): строки в
    // ленте нет, отметка supervisorNotifiedAt остаётся.
    const feedRow = await prisma.notification.findFirst({
      where: {
        agentId: directorId,
        tag: { startsWith: "overdue-batch-" },
        // По числу прогона, а не по имени целиком: в сводке имя проходит через
        // formatClientName, и слово «Клиент» она съедает как заглушку — в теле
        // стоит «Покупатель показа <runId>».
        body: { contains: String(runId) },
      },
    });
    expect(feedRow).toBeNull();
    const afterSupervisor = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(afterSupervisor?.supervisorNotifiedAt).not.toBeNull();
  });

  it("просроченная обычная задача — та же сводка руководству", async () => {
    const task = await makeTask("CALL", -150);

    // Та же сводка одним push, что и у встречи выше (коммит 312891c2), теперь
    // отдельным сборщиком notifySupervisorsOfOverdue (07.09.2026).
    sendPushToAgent.mockClear();
    expect(await notifySupervisorsOfOverdue(NOW)).toBeGreaterThan(0);
    expect(
      sendPushToAgent.mock.calls.some(([, payload]) =>
        String((payload as Record<string, string>).tag ?? "").startsWith("overdue-batch-")
      )
    ).toBe(false);
    const feedRow = await prisma.notification.findFirst({
      where: { agentId: directorId, tag: { startsWith: "overdue-batch-" } },
      orderBy: { createdAt: "desc" },
    });
    expect(feedRow).toBeNull();
    const afterSupervisor = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(afterSupervisor?.supervisorNotifiedAt).not.toBeNull();
  });

  it("закрыли поздно — баллов нет ни плюсом, ни минусом (штраф снят 16.11.2026)", async () => {
    const task = await makeTask("CALL", -150);
    // Срок — в настоящем прошлом: completeInteractionTask сверяет с реальным «сейчас».
    await prisma.interaction.update({ where: { id: task.id }, data: { nextActionDate: new Date(Date.now() - 2 * 3600_000) } });
    const { completeInteractionTask } = await import("../src/lib/taskCompletion.js");
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
    const { changed } = await completeInteractionTask(row);
    expect(changed).toBe(true);
    const events = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { sourceId: task.id } }));
    expect(events).toBe(0);
  });

  it("закрыли вовремя — плюс за задачу остаётся", async () => {
    const task = await makeTask("CALL", 60);
    const { completeInteractionTask } = await import("../src/lib/taskCompletion.js");
    const row = await prisma.interaction.findUniqueOrThrow({ where: { id: task.id } });
    await completeInteractionTask(row);
    const event = await waitFor(() => prisma.royalScoreEvent.findFirst({ where: { sourceId: task.id } }));
    expect(event?.kind).toBe("task_on_time");
  });
});
