import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";

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
const { sendHourBeforeReminders, notifyMissedShowings, notifyOverdueTasks, notifySupervisorsOfOverdue } = await import(
  "../src/lib/meetingReminders.js"
);
const { DEFAULT_EVENT_POINTS } = await import("../src/lib/scoreJournal.js");

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
    const task = await makeTask("SHOWING", -150);
    expect(await notifyMissedShowings(NOW)).toBe(1);
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.noShowNotifiedAt).not.toBeNull();

    // Самому агенту пуш и запись в ленту убраны (решение владельца 02.10.2026).
    const agentCalls = sendPushToAgent.mock.calls as unknown as [string | string[], Record<string, string>][];
    const agentCall = agentCalls.find(
      ([to, p]) => (Array.isArray(to) ? to.includes(agentId) : to === agentId) && p.tag?.endsWith("-agent")
    );
    expect(agentCall, "агенту «Показ не отмечен» больше не шлём").toBeUndefined();

    // Руководству — отдельным сборщиком (07.09.2026, часы алармов), не отсюда.
    sendPushToAgent.mockClear();
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
    expect(await notifyMissedShowings(NOW)).toBe(0);
  });

  it("отмеченный выполненным показ руководство не беспокоит", async () => {
    const task = await makeTask("SHOWING", -150);
    await prisma.interaction.update({ where: { id: task.id }, data: { completedAt: new Date() } });
    expect(await notifyMissedShowings(NOW)).toBe(0);
  });

  it("показ, время которого ещё не прошло, не считается сорванным", async () => {
    await makeTask("SHOWING", -30);
    expect(await notifyMissedShowings(NOW)).toBe(0);
  });
});

describe("Просроченные встречи и задачи, никогда не закрытые", () => {
  it("просроченная встреча — штраф meeting_overdue, руководству сводки нет", async () => {
    const task = await makeTask("MEETING", -150);
    expect(await notifyOverdueTasks(NOW)).toBeGreaterThan(0);
    const after = await prisma.interaction.findUnique({ where: { id: task.id } });
    expect(after?.noShowNotifiedAt).not.toBeNull();
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: task.id } });
    expect(event?.kind).toBe("meeting_overdue");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.meeting_overdue);

    // Самому агенту пуш и запись в ленту убраны (решение владельца 02.10.2026).
    const agentCall = (sendPushToAgent.mock.calls as unknown as [string | string[], Record<string, string>][]).find(
      ([to, p]) => (Array.isArray(to) ? to.includes(agentId) : to === agentId) && p.tag?.endsWith("-agent")
    );
    expect(agentCall, "агенту «Встреча просрочена» больше не шлём").toBeUndefined();

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

  it("просроченная обычная задача — task_overdue", async () => {
    const task = await makeTask("CALL", -150);
    expect(await notifyOverdueTasks(NOW)).toBeGreaterThan(0);
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: task.id } });
    expect(event?.kind).toBe("task_overdue");
    expect(event?.delta).toBe(DEFAULT_EVENT_POINTS.task_overdue);

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

  it("показ сюда не попадает — своя ветка выше", async () => {
    await makeTask("SHOWING", -150);
    await notifyMissedShowings(NOW); // разбирает показ первым, помечает noShowNotifiedAt
    sendPushToAgent.mockClear();
    expect(await notifyOverdueTasks(NOW)).toBe(0);
  });

  it("если запись потом всё же закрыли поздно — второй раз баллы не начисляются", async () => {
    const task = await makeTask("CALL", -150);
    await notifyOverdueTasks(NOW);
    const before = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId, sourceId: task.id } }));
    // Агент наконец закрывает задачу — тот же путь, что и обычное позднее закрытие
    // (routes/interactions.ts), с тем же sourceId. Уникальность (kind, sourceId)
    // не даёт начислить task_overdue второй раз.
    const { recordScoreEvent, loadEventPoints } = await import("../src/lib/scoreJournal.js");
    const points = await loadEventPoints();
    await recordScoreEvent({ agentId, kind: "task_overdue", delta: points.task_overdue, reason: "Закрыто с опозданием", sourceId: task.id });
    const after = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId, sourceId: task.id } }));
    expect(after).toBe(before);
  });

  it("второй тик по уже сообщённой записи не штрафует второй раз", async () => {
    const task = await makeTask("CALL", -150);
    await notifyOverdueTasks(NOW);
    const before = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId, sourceId: task.id } }));
    expect(await notifyOverdueTasks(NOW)).toBe(0);
    const after = await waitForSettled(() => prisma.royalScoreEvent.count({ where: { agentId, sourceId: task.id } }));
    expect(after).toBe(before);
  });
});
