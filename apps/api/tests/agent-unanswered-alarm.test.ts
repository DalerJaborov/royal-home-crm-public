import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  findUnansweredClients,
  isUnanswered,
  runAgentUnansweredAlarmTick,
} from "../src/lib/agentUnansweredAlarm.js";

/**
 * «Продавец пишет, а агент не отвечает» (владелец 09.09.2026) — единственная
 * тревога в CRM, которая считает не от обязанности агента действовать, а от его
 * молчания в ответ на клиента.
 *
 * Часы алармов замоканы: тик молчит вне окна, и без мока тесты зависели бы от
 * времени суток, в которое их запустили.
 */
vi.mock("../src/lib/workingHours.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/workingHours.js")>();
  return { ...actual, isWithinAlarmHours: async () => true };
});

const DAY = 24 * 3600_000;
/**
 * Четверг — тот же безопасный день недели, что уже используется в блоке
 * «Отсчёт начинается не раньше назначения». 13.09.2026 (воскресенье) —
 * нерабочий день по alarmCalendar.ts (решение владельца 08.09.2026), и любой
 * тест, который считает «N дней назад» от реального Date.now(), в такой день
 * теряет одни рабочие сутки и ломается детерминированно. Фиксируем время,
 * чтобы тест не зависел от дня запуска.
 */
const FIXED_NOW = new Date("2026-09-10T12:00:00+05:00");
const runId = Date.now();
let agentId: string;
let directorId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент молчания", phone: `+992946${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор молчания", phone: `+992947${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { agentId: { in: [agentId, directorId] } } });
});

async function makeSeller(opts: {
  clientWroteDaysAgo: number;
  agentRepliedDaysAgo?: number;
  absent?: boolean;
  status?: "NEW" | "LOST" | "DEAL_CLOSED";
  kind?: "SELLER" | "BUYER";
  /** false — лид агенту назначен, но он его ещё не принял (№142). */
  accepted?: boolean;
  escalatedDaysAgo?: number;
}) {
  const idx = clientIds.length;
  const c = await prisma.client.create({
    data: {
      fullName: `Продавец молчания ${runId}-${idx}`,
      phone: `+992948${runId}${idx}`,
      source: "PHONE_CALL",
      kind: opts.kind ?? "SELLER",
      status: opts.status ?? "NEW",
      workStatus: "ACTIVE",
      assignedAgentId: agentId,
      /**
       * Карточка у агента давно. Отсчёт молчания идёт от ПОЗДНЕЙШЕГО из двух —
       * сообщения клиента и назначения карточки (см. isUnanswered): иначе любая
       * передача вешала бы на нового агента молчание предшественника, и он
       * становился бы виноват в первую же минуту.
       */
      assignedAt: new Date(FIXED_NOW.getTime() - 30 * DAY),
      // Принятая карточка — как у всех рабочих: миграция 20260710183343
      // проставила acceptedAt всем старым, каждый путь принятия ставит его сам.
      acceptedAt: opts.accepted === false ? null : new Date(FIXED_NOW.getTime() - 30 * DAY),
      escalatedAt:
        opts.escalatedDaysAgo === undefined ? null : new Date(FIXED_NOW.getTime() - opts.escalatedDaysAgo * DAY),
      lastClientMessageAt: new Date(FIXED_NOW.getTime() - opts.clientWroteDaysAgo * DAY),
      lastAgentAttemptAt:
        opts.agentRepliedDaysAgo === undefined
          ? null
          : new Date(FIXED_NOW.getTime() - opts.agentRepliedDaysAgo * DAY),
    },
  });
  clientIds.push(c.id);
  return c;
}

describe("Отсчёт начинается не раньше назначения", () => {
  const now = new Date("2026-09-10T12:00:00+05:00");

  /**
   * Без этого пола передача карточки мгновенно вешала бы на нового агента
   * молчание предшественника: он получает клиента и в ту же минуту виноват в
   * трёх днях тишины. Для удалённой 16.09.2026 автопередачи это было ещё
   * и вечная карусель — карточка скакала бы от агента к агенту каждый час.
   */
  it("карточку передали только что — молчания нет, сколько бы клиент ни ждал", () => {
    const v = isUnanswered({
      lastClientMessageAt: new Date("2026-09-01T10:00:00+05:00"),
      lastAgentAttemptAt: null,
      assignedAt: new Date("2026-09-10T11:00:00+05:00"),
      agentWhere: "present",
      now,
    });
    expect(v.unanswered).toBe(false);
    expect(v.workingDaysSilent).toBe(0);
  });

  it("карточка у агента давно — считаем от сообщения клиента, как раньше", () => {
    const v = isUnanswered({
      lastClientMessageAt: new Date("2026-09-08T10:00:00+05:00"),
      lastAgentAttemptAt: null,
      assignedAt: new Date("2026-08-01T10:00:00+05:00"),
      agentWhere: "present",
      now,
    });
    expect(v.unanswered).toBe(true);
  });

  it("без даты назначения правило работает как прежде", () => {
    const v = isUnanswered({
      lastClientMessageAt: new Date("2026-09-08T10:00:00+05:00"),
      lastAgentAttemptAt: null,
      agentWhere: "present",
      now,
    });
    expect(v.unanswered).toBe(true);
  });
});

async function setAgentAbsent(absent: boolean) {
  await prisma.agent.update({
    where: { id: agentId },
    data: absent ? { frozenAt: new Date(), frozenReason: "Отпуск" } : { frozenAt: null, frozenReason: null },
  });
}

async function alertedFor(clientId: string): Promise<boolean> {
  const n = await prisma.notification.findFirst({ where: { tag: `agent-unanswered-${clientId}` } });
  return n !== null;
}

describe("Правило без базы", () => {
  const now = new Date("2026-09-09T12:00:00Z"); // среда

  it("клиент не писал вовсе — тревоги нет", () => {
    expect(
      isUnanswered({ lastClientMessageAt: null, lastAgentAttemptAt: null, agentWhere: "present", now })
    ).toEqual({ unanswered: false, workingDaysSilent: 0 });
  });

  /** Агент ответил — вопрос закрыт, в каком канале, неважно. */
  it("агент ответил после сообщения — тревоги нет", () => {
    const msg = new Date(now.getTime() - 5 * DAY);
    const reply = new Date(now.getTime() - 4 * DAY);
    expect(
      isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: reply, agentWhere: "present", now }).unanswered
    ).toBe(false);
  });

  it("ответ был ДО сообщения — не считается", () => {
    const reply = new Date(now.getTime() - 6 * DAY);
    const msg = new Date(now.getTime() - 5 * DAY);
    expect(
      isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: reply, agentWhere: "present", now }).unanswered
    ).toBe(true);
  });

  /**
   * ПОРОГ ОДИН НА ВСЕХ — ДВОЕ РАБОЧИХ СУТОК (владелец 16.09.2026). Было: на месте
   * один день, в отсутствие два. Отсутствие агента для КЛИЕНТА не смягчающее
   * обстоятельство — он про отпуск не знает и ждёт ответа так же.
   */
  it("сутки молчания — ещё терпим, кем бы агент ни был", () => {
    const msg = new Date(now.getTime() - 1.5 * DAY);
    expect(isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: null, agentWhere: "present", now }).unanswered).toBe(false);
    expect(isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: null, agentWhere: "absent", now }).unanswered).toBe(false);
  });

  it("двое суток — будим владельца, и отсутствие срок не удлиняет", () => {
    const msg = new Date(now.getTime() - 3 * DAY);
    expect(isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: null, agentWhere: "present", now }).unanswered).toBe(true);
    expect(isUnanswered({ lastClientMessageAt: msg, lastAgentAttemptAt: null, agentWhere: "absent", now }).unanswered).toBe(true);
  });

  /**
   * Ночное сообщение не должно съедать сутки: если считать от 23:00, срок истечёт
   * в 23:00 следующего дня — агенту подарена ночь, у владельца отнято полдня.
   */
  it("сообщение ночью — отсчёт с начала рабочего дня, а не с минуты сообщения", () => {
    // Вторник 23:00 по Душанбе = 18:00 UTC.
    const night = new Date("2026-09-08T18:00:00Z");
    // Среда 20:00 по Душанбе: от начала рабочей среды (09:30) прошло меньше суток.
    const nextEvening = new Date("2026-09-09T15:00:00Z");
    const v = isUnanswered({
      lastClientMessageAt: night,
      lastAgentAttemptAt: null,
      agentWhere: "present",
      now: nextEvening,
      dayStartHHMM: "09:30",
    });
    expect(v.unanswered).toBe(false);
  });

  /** Общий выходной (воскресенье в Настройках) в счёт не идёт — за нерабочий день не наказываем. */
  it("общий выходной в воскресенье пропускается (companyDaysOff: [0])", () => {
    // Суббота 12:00 по Душанбе.
    const sat = new Date("2026-09-05T07:00:00Z");
    // Понедельник 12:00 — календарно двое суток, рабочих одни.
    const mon = new Date("2026-09-07T07:00:00Z");
    const v = isUnanswered({
      lastClientMessageAt: sat,
      lastAgentAttemptAt: null,
      agentWhere: "absent",
      now: mon,
      calendar: { companyDaysOff: [0] },
    });
    expect(v.unanswered).toBe(false);
  });

  /** Владелец 11.10.2026: выходных нет по умолчанию — воскресенье рабочий день. */
  it("по умолчанию воскресенье рабочее: суббота → понедельник — двое суток, тревога", () => {
    const sat = new Date("2026-09-05T07:00:00Z");
    const mon = new Date("2026-09-07T07:00:00Z");
    const v = isUnanswered({ lastClientMessageAt: sat, lastAgentAttemptAt: null, agentWhere: "present", now: mon });
    expect(v.unanswered).toBe(true);
  });

  /** Личный выходной ЭТОГО агента (воскресенье) — пропускается, как общий. */
  it("личный выходной агента пропускается", () => {
    const sat = new Date("2026-09-05T07:00:00Z");
    const mon = new Date("2026-09-07T07:00:00Z");
    const v = isUnanswered({
      lastClientMessageAt: sat,
      lastAgentAttemptAt: null,
      agentWhere: "present",
      now: mon,
      calendar: { companyDaysOff: [], agentDaysOff: [0] },
    });
    expect(v.unanswered).toBe(false);
  });
});

describe("Поиск по базе", () => {
  it("двое суток молчания — продавец в списке", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3 });
    const found = await findUnansweredClients(FIXED_NOW);
    expect(found.some((f) => f.clientId === c.id)).toBe(true);
  });

  /**
   * №142 (ночная проверка 24.09): лид агенту назначен, но НЕ ПРИНЯТ — переписка
   * ему до принятия закрыта (lib/chatScope.ts, ownChatClientWhere), ответить
   * он не может. Тревога «агент не отвечает» и задача «Клиент ждёт ответа» по
   * такому лиду винят агента в том, чего он сделать не мог: непринятым лидом
   * занимается лесенка назначения и эскалация, а не эта тревога.
   */
  it("лид не принят (в том числе эскалирован) — агента не винят, в списке его нет", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3, accepted: false, escalatedDaysAgo: 2 });
    const found = await findUnansweredClients(FIXED_NOW);
    expect(found.some((f) => f.clientId === c.id)).toBe(false);
  });

  it("агент ответил — продавца в списке нет", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3, agentRepliedDaysAgo: 1 });
    const found = await findUnansweredClients(FIXED_NOW);
    expect(found.some((f) => f.clientId === c.id)).toBe(false);
  });

  /**
   * ПОКУПАТЕЛЬ ТЕПЕРЬ ТОЖЕ (владелец 16.09.2026: «не отвечает продавцу ИЛИ
   * покупателю»). До этого тревога смотрела только продавцов, и покупатель,
   * которому не ответили двое суток, не замечался вообще никем.
   */
  it("покупателю не ответили двое суток — он в списке, и назван покупателем", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3, kind: "BUYER" });
    const found = await findUnansweredClients(FIXED_NOW);
    const row = found.find((f) => f.clientId === c.id);
    expect(row).toBeDefined();
    expect(row!.clientKind).toBe("BUYER");
  });

  it("агент в отпуске — сутки ещё терпим", async () => {
    await setAgentAbsent(true);
    try {
      const c = await makeSeller({ clientWroteDaysAgo: 1 });
      const found = await findUnansweredClients(FIXED_NOW);
      expect(found.some((f) => f.clientId === c.id)).toBe(false);
    } finally {
      await setAgentAbsent(false);
    }
  });

  it("агент в отпуске, трое суток — уже нет", async () => {
    await setAgentAbsent(true);
    try {
      const c = await makeSeller({ clientWroteDaysAgo: 3 });
      const found = await findUnansweredClients(FIXED_NOW);
      const row = found.find((f) => f.clientId === c.id);
      expect(row?.agentWhere).toBe("absent");
    } finally {
      await setAgentAbsent(false);
    }
  });

  /**
   * Правило касается ВСЕХ продавцов — активных, потерянных, с закрытой сделкой.
   * Разница только в срочности уведомления, а не в самом факте.
   */
  it("продавец с закрытой сделкой тоже попадает", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 2, status: "DEAL_CLOSED" });
    const found = await findUnansweredClients(FIXED_NOW);
    expect(found.some((f) => f.clientId === c.id)).toBe(true);
  });

  /**
   * КАРТОЧКА ЗА ПОТОЛКОМ ВЫБОРКИ НЕ ТЕРЯЕТСЯ (ночная проверка 24.09.2026,
   * находка №2). Раньше выборка брала всех писавших клиентов `take: 300` без
   * `orderBy` — Prisma сортировала по `id` (uuid), — а «ответил ли агент»
   * решалось уже в JS. 301 отвеченная карточка с `id` от `0000…` заполняла срез
   * целиком, и неотвеченная с `id` `ffff…` не проверялась никогда. Теперь
   * условие «нет ответа после сообщения» стоит в самом запросе.
   */
  it("301 отвеченная карточка впереди по id — неотвеченная позади всё равно находится", async () => {
    const tail = String(runId).padStart(12, "0").slice(-12);
    const answeredIds = Array.from({ length: 301 }, (_, i) => `00000000-0000-0000-${String(i).padStart(4, "0")}-${tail}`);
    const silentId = `ffffffff-ffff-ffff-ffff-${tail}`;
    await prisma.client.deleteMany({ where: { id: { in: [...answeredIds, silentId] } } });
    await prisma.client.createMany({
      data: answeredIds.map((id, i) => ({
        id,
        fullName: `Отвеченный ${runId}-${i}`,
        phone: `+992949${runId}${i}`,
        source: "PHONE_CALL" as const,
        kind: "SELLER" as const,
        assignedAgentId: agentId,
        assignedAt: new Date(FIXED_NOW.getTime() - 30 * DAY),
        acceptedAt: new Date(FIXED_NOW.getTime() - 30 * DAY),
        lastClientMessageAt: new Date(FIXED_NOW.getTime() - 3 * DAY),
        // Агент ответил ПОСЛЕ сообщения — эти карточки тревоги не заслуживают.
        lastAgentAttemptAt: new Date(FIXED_NOW.getTime() - 2 * DAY),
      })),
    });
    await prisma.client.create({
      data: {
        id: silentId,
        fullName: `Неотвеченный позади ${runId}`,
        phone: `+992949${runId}x`,
        source: "PHONE_CALL",
        kind: "SELLER",
        assignedAgentId: agentId,
        assignedAt: new Date(FIXED_NOW.getTime() - 30 * DAY),
        acceptedAt: new Date(FIXED_NOW.getTime() - 30 * DAY),
        lastClientMessageAt: new Date(FIXED_NOW.getTime() - 3 * DAY),
        lastAgentAttemptAt: null,
      },
    });
    clientIds.push(...answeredIds, silentId);

    const found = await findUnansweredClients(FIXED_NOW);
    expect(found.some((f) => f.clientId === silentId)).toBe(true);
    expect(found.some((f) => answeredIds.includes(f.clientId))).toBe(false);
  });
});

describe("Тик крона", () => {
  it("руководству записи нет (владелец 02.10.2026), а задача в делах держателя есть и не двоится", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 2 });

    const first = await runAgentUnansweredAlarmTick(FIXED_NOW);
    expect(first.alerted).toBeGreaterThanOrEqual(1);
    expect(await alertedFor(c.id)).toBe(false);

    await runAgentUnansweredAlarmTick(FIXED_NOW);
    expect(await alertedFor(c.id)).toBe(false);
    const tasks = await prisma.interaction.count({
      where: { clientId: c.id, subjectAgentId: agentId, type: "SYSTEM", notes: { startsWith: "[agentUnansweredAlarm]" } },
    });
    expect(tasks).toBe(1);
  });

  it("агент ответил — ни записи руководству, ни задачи", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3, agentRepliedDaysAgo: 0 });
    await runAgentUnansweredAlarmTick(FIXED_NOW);
    expect(await alertedFor(c.id)).toBe(false);
    const tasks = await prisma.interaction.count({
      where: { clientId: c.id, type: "SYSTEM", notes: { startsWith: "[agentUnansweredAlarm]" } },
    });
    expect(tasks).toBe(0);
  });

  /**
   * Р-1 (17.09.2026): клиент остаётся у агента, но САМ АГЕНТ тоже должен узнать,
   * что клиент ждёт — раньше уходило только руководству. Пуш держателю и строка
   * в его делах (Interaction SYSTEM, nextAction) — не передача, владение не
   * меняется.
   */
  it("держатель получает строку в делах, а пуша ему нет (владелец 02.10.2026) — и без передачи", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3 });
    await runAgentUnansweredAlarmTick(FIXED_NOW);
    // Пуш держателю убран: «Окно чата закрыто — позвоните» владелец назвал лишним.
    await new Promise((r) => setTimeout(r, 200));
    const holderNotif = await prisma.notification.findFirst({ where: { tag: `agent-unanswered-holder-${c.id}` } });
    expect(holderNotif).toBeNull();

    // П-10 (задание Б2, 18.09.2026): автоматика, не сам агент — agentId null,
    // держатель виден через subjectAgentId.
    const task = await prisma.interaction.findFirst({
      where: { clientId: c.id, subjectAgentId: agentId, type: "SYSTEM", notes: { startsWith: "[agentUnansweredAlarm]" } },
    });
    expect(task).not.toBeNull();
    expect(task!.actorKind).toBe("SYSTEM");
    expect(task!.agentId).toBeNull();
    expect(task!.nextAction).toContain("раб. дн.");

    const client = await prisma.client.findUnique({ where: { id: c.id } });
    expect(client!.assignedAgentId).toBe(agentId);
  });

  it("повторный тик той же тишины не плодит вторую задачу", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3 });
    await runAgentUnansweredAlarmTick(FIXED_NOW);
    await runAgentUnansweredAlarmTick(FIXED_NOW);
    const count = await prisma.interaction.count({
      where: { clientId: c.id, subjectAgentId: agentId, type: "SYSTEM", notes: { startsWith: "[agentUnansweredAlarm]" } },
    });
    expect(count).toBe(1);
  });

  /** Окно WhatsApp/Instagram (24 ч) закрыто — то же самое поле lastClientMessageAt,
   *  которое уже используется для самого молчания: последнее входящее старше суток. */
  it("окно WhatsApp закрыто — задача говорит «позвоните», а не «напишите»", async () => {
    const c = await makeSeller({ clientWroteDaysAgo: 3 });
    await runAgentUnansweredAlarmTick(FIXED_NOW);
    const task = await prisma.interaction.findFirst({
      where: { clientId: c.id, subjectAgentId: agentId, type: "SYSTEM", notes: { startsWith: "[agentUnansweredAlarm]" } },
    });
    expect(task!.nextAction).toContain("окно закрыто — позвоните");
  });
});
