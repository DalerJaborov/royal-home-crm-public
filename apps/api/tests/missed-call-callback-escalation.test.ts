import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { dushanbeInputToDate } = await import("../src/lib/dushanbeTime.js");
const missedCallEscalation = await import("../src/lib/telephony/missedCallEscalation.js");
const { elapsedWorkingMinutes, hasCallbackContact, findCallbackContacts, countMissedCallsNoCallbackYesterday } =
  missedCallEscalation;

/**
 * «Пропущенный звонок без перезвона» (Пачка 18, 12.09.2026): факт с прода —
 * 24 пропущенных за 30 дней без исходящего контакта в течение суток.
 *
 * СТУПЕНЕЙ И ТИКА БОЛЬШЕ НЕТ (решения владельца 20.09.2026: сначала «напоминания
 * агенту убери», потом «полностью удали пуш и эскалацию руководителю, нам это не
 * нужно»). От механизма остались чистая арифметика рабочих часов и два счётчика —
 * их и проверяем; отсутствие самого тика проверяется отдельным тестом, иначе пуш
 * вернулся бы однажды молча.
 *
 * Рабочее окно на время DB-тестов держим 00:00-23:59 (Settings.workHours*), чтобы
 * прогон не зависел от времени суток.
 */

const runId = Date.now();
let agentId: string;
let directorId: string;
const clientIds: string[] = [];
const callIds: string[] = [];

async function makeClient(overrides: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент пропущенного ${runId}-${clientIds.length}`,
      phone: `+992937${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      ...overrides,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeCall(overrides: Record<string, unknown> = {}) {
  const c = await prisma.incomingCall.create({
    data: {
      channelId: `missed-cb-${runId}-${callIds.length}`,
      phone: `+992938${runId}${callIds.length}`,
      answered: false,
      irrelevant: false,
      ...overrides,
    },
  });
  callIds.push(c.id);
  return c;
}

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент пропущенных", phone: `+992939${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор пропущенных", phone: `+992930${runId}`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  // Рабочее окно "круглые сутки" — только для DB-тестов эскалации, см. шапку файла.
  await prisma.settings.update({
    where: { id: "singleton" },
    // Круглые сутки — это "00:00"–"24:00", а НЕ "00:00"–"23:59": минута 23:59 у
    // второго остаётся закрытой, и тест падает одну минуту в сутки
    // (isWithinDushanbeWindow → false, заявка уходит в общую очередь без агента).
    // "00:00"–"00:00" тоже нельзя: у isWithinDushanbeWindow пустое окно значит
    // «никогда». Разбор — docs/journal/2026-09-24-krugolosutochnoe-okno-24-00.md.
    data: { workHoursStart: "00:00", workHoursEnd: "24:00", missedCallbackHours: 1, missedCallbackEscalateHours: 2 },
  });
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "missed-callback-" } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { workHoursStart: "09:30", workHoursEnd: "18:00", missedCallbackHours: 2, missedCallbackEscalateHours: 6 },
  });
});

describe("elapsedWorkingMinutes — рабочие часы считаются верно", () => {
  it("звонок и сейчас в одном дневном окне — считает как есть", () => {
    const from = dushanbeInputToDate("2026-09-14", "10:00"); // понедельник
    const to = dushanbeInputToDate("2026-09-14", "11:30");
    expect(elapsedWorkingMinutes(from, to, "09:30", "18:00")).toBeCloseTo(90, 0);
  });

  it("звонок ночью — простой до полуночи не считается, тикает только с открытия окна", () => {
    const from = dushanbeInputToDate("2026-09-14", "23:00"); // ночь понедельника
    const to = dushanbeInputToDate("2026-09-15", "10:30"); // 10:30 вторника
    // Окно открылось в 09:30 вторника — прошёл ровно час рабочего времени,
    // а не 11.5 часов астрономических.
    expect(elapsedWorkingMinutes(from, to, "09:30", "18:00")).toBeCloseTo(60, 0);
  });

  it("выходной внутри диапазона всё равно не рабочее время — окно у нас ежедневное, считаем оба дня", () => {
    const from = dushanbeInputToDate("2026-09-14", "17:00");
    const to = dushanbeInputToDate("2026-09-16", "10:00");
    // День 1: 17:00-18:00 = 60 мин. День 2 (15-е) полностью в окне: 09:30-18:00 = 510 мин.
    // День 3: 09:30-10:00 = 30 мин. Итого 600 минут.
    expect(elapsedWorkingMinutes(from, to, "09:30", "18:00")).toBeCloseTo(600, 0);
  });

  it("to раньше from — ноль, не отрицательное число", () => {
    const from = dushanbeInputToDate("2026-09-14", "12:00");
    const to = dushanbeInputToDate("2026-09-14", "10:00");
    expect(elapsedWorkingMinutes(from, to, "09:30", "18:00")).toBe(0);
  });
});

describe("эскалации и напоминаний больше нет", () => {
  it("модуль не отдаёт ни тика, ни пуша — чтобы уведомление не вернулось молча", () => {
    // Решения владельца 20.09.2026 (см. шапку файла). Тест сторожит именно факт
    // ОТСУТСТВИЯ: раньше механизм слал напоминание агенту и эскалацию руководству,
    // и вернуть их случайной правкой легко — падение здесь заставит перечитать
    // решение, а не тихо восстановить пуш.
    expect("runMissedCallCallbackEscalationTick" in missedCallEscalation).toBe(false);
    expect(sendPushToAgent).not.toHaveBeenCalled();
    expect(sendPushToAgents).not.toHaveBeenCalled();
  });
});

describe("hasCallbackContact — что считается перезвоном", () => {
  it("разговор или сообщение после звонка — перезвон есть", async () => {
    const client = await makeClient();
    const startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Перезвонили клиенту",
        outcome: "NEUTRAL",
        createdAt: new Date(startedAt.getTime() + 10 * 60_000),
      },
    });

    expect(await hasCallbackContact(client.id, startedAt)).toBe(true);
  });

  /**
   * Сообщение агента (type MESSAGE) всегда без outcome — в базе NULL. Здесь стояло
   * `NOT: { outcome: "NO_ANSWER" }`, то есть SQL `outcome <> 'NO_ANSWER'`, а
   * `NULL <> '...'` в Postgres не истина: строка выпадала, контакт не засчитывался,
   * и звонок висел «без перезвона» в журнале и в утренних числах директора.
   * Остальные тесты этого блока задают outcome явно, поэтому дыру не показывали.
   */
  it("сообщение без outcome (NULL) после звонка — перезвон есть", async () => {
    const client = await makeClient();
    const startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "MESSAGE",
        notes: "Написали клиенту в WhatsApp",
        // outcome НЕ задан — в базе NULL, как у любого сообщения.
        createdAt: new Date(startedAt.getTime() + 10 * 60_000),
      },
    });

    expect(await hasCallbackContact(client.id, startedAt)).toBe(true);
  });

  it("только недозвон (NO_ANSWER) — перезвона нет", async () => {
    const client = await makeClient();
    const startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Не взял трубку",
        outcome: "NO_ANSWER",
        createdAt: new Date(startedAt.getTime() + 10 * 60_000),
      },
    });

    expect(await hasCallbackContact(client.id, startedAt)).toBe(false);
  });

  it("контакт РАНЬШЕ звонка не считается — иначе перезвоном был бы любой прошлый разговор", async () => {
    const client = await makeClient();
    const startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "MESSAGE",
        notes: "Писали накануне",
        outcome: "NEUTRAL",
        createdAt: new Date(startedAt.getTime() - 60 * 60_000),
      },
    });

    expect(await hasCallbackContact(client.id, startedAt)).toBe(false);
  });
});

/**
 * ПАЧЕЧНАЯ ВЕРСИЯ (22.09.2026). До неё журнал «Звонки» с фильтром «без перезвона»
 * делал по запросу на КАЖДОГО из 1000 кандидатов, а утренние числа — на каждого из
 * 2000. Экран не падал и не предупреждал, он просто открывался тем дольше, чем
 * больше звонков накопилось.
 *
 * Проверяем не скорость (её тест не измерит честно), а то, ради чего пачка заведена:
 * ответ у неё ТОТ ЖЕ, что у поштучной, включая разные `since` у разных звонков в
 * одной пачке — именно на этом пачечный вариант и ломается, если сравнивать с общей
 * границей вместо собственной у каждого звонка.
 */
describe("findCallbackContacts — тот же признак на пачку звонков", () => {
  it("у каждого звонка своя граница: ранний перезвон не засчитывается позднему звонку", async () => {
    const early = await makeClient();
    const late = await makeClient();
    const base = Date.now() - 6 * 60 * 60_000;

    // Контакт через 10 минут после РАННЕГО звонка. Для раннего это перезвон,
    // для позднего (он на два часа позже контакта) — нет.
    await prisma.interaction.create({
      data: {
        clientId: early.id,
        agentId,
        type: "CALL",
        notes: "Перезвонили",
        outcome: "NEUTRAL",
        createdAt: new Date(base + 10 * 60_000),
      },
    });
    await prisma.interaction.create({
      data: {
        clientId: late.id,
        agentId,
        type: "CALL",
        notes: "Звонили до того, как он нам звонил",
        outcome: "NEUTRAL",
        createdAt: new Date(base + 10 * 60_000),
      },
    });

    const earlyStartedAt = new Date(base);
    const lateStartedAt = new Date(base + 2 * 60 * 60_000);
    const done = await findCallbackContacts([
      { id: "early", clientId: early.id, since: earlyStartedAt },
      { id: "late", clientId: late.id, since: lateStartedAt },
    ]);

    expect(done.has("early")).toBe(true);
    expect(done.has("late")).toBe(false);
    // И тот же ответ, что у поштучной версии — чтобы копии правила не разъехались.
    expect(await hasCallbackContact(early.id, earlyStartedAt)).toBe(true);
    expect(await hasCallbackContact(late.id, lateStartedAt)).toBe(false);
  });

  it("недозвон не считается и в пачке", async () => {
    const client = await makeClient();
    const startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        agentId,
        type: "CALL",
        notes: "Не взял трубку",
        outcome: "NO_ANSWER",
        createdAt: new Date(startedAt.getTime() + 10 * 60_000),
      },
    });

    const done = await findCallbackContacts([{ id: "a", clientId: client.id, since: startedAt }]);
    expect(done.has("a")).toBe(false);
  });

  it("пустая пачка не ходит в базу и отдаёт пустой набор", async () => {
    await expect(findCallbackContacts([])).resolves.toEqual(new Set());
  });
});

describe("countMissedCallsNoCallbackYesterday — утренние числа директора", () => {
  /** Счёт по всей базе стенда, поэтому проверяем РАЗНИЦУ, а не абсолютное число:
   *  соседние сьюты держат свои пропущенные звонки в тех же сутках. */
  it("вчерашний пропущенный без перезвона считается, с перезвоном — нет", async () => {
    const startOfToday = dushanbeInputToDate(new Date().toISOString().slice(0, 10), "00:00");
    const yesterdayNoon = new Date(startOfToday.getTime() - 12 * 60 * 60_000);
    const before = await countMissedCallsNoCallbackYesterday(startOfToday);

    const lost = await makeClient();
    await makeCall({ clientId: lost.id, callbackAgentId: agentId, startedAt: yesterdayNoon });
    expect(await countMissedCallsNoCallbackYesterday(startOfToday)).toBe(before + 1);

    const handled = await makeClient();
    await makeCall({ clientId: handled.id, callbackAgentId: agentId, startedAt: yesterdayNoon });
    await prisma.interaction.create({
      data: {
        clientId: handled.id,
        agentId,
        type: "CALL",
        notes: "Перезвонили",
        outcome: "NEUTRAL",
        createdAt: new Date(yesterdayNoon.getTime() + 30 * 60_000),
      },
    });
    expect(await countMissedCallsNoCallbackYesterday(startOfToday)).toBe(before + 1);
  });
});
