import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  runIncomingCallsSilenceTick,
  SILENCE_HOURS,
  BASELINE_DAYS,
  DEAD_CALL_SECONDS,
  SAME_WEEKDAY_QUIET_MAX,
} from "../src/lib/telephony/incomingCallsSilenceAlarm.js";

/**
 * Регрессионный тест сторожа «входящие не доходят» (разбор 19.09.2026: с
 * 21.08.2026 звонки умирали за ~50 мс, и об этом не узнал ни один механизм —
 * ни ошибки, ни записи звонка, месяц тишины).
 *
 * Время фиксировано и лежит в прошлом НАМЕРЕННО: окна сторожа (4 часа, сутки и
 * неделя назад) не должны задевать записи, которые заводят соседние тесты «сейчас».
 */

const runId = Date.now();
/** Вторник 12:00 по Душанбе — внутри часов алармов, как у соседних тестов алармов. */
const NOW = new Date("2026-09-01T07:00:00Z");
const HOUR_MS = 3_600_000;

const TAGS = ["incoming-calls-silence", "incoming-calls-dead"];

let directorId: string;
let prevAriUrl: string | null = null;
let prevAlarmStart: string | null = null;
let prevAlarmEnd: string | null = null;
const callIds: string[] = [];

/** Входящий звонок с заданным сдвигом назад от NOW (или от `from`) и заданной длительностью. */
async function seedCall(opts: { hoursAgo: number; seconds: number; answered?: boolean; from?: Date }) {
  const startedAt = new Date((opts.from ?? NOW).getTime() - opts.hoursAgo * HOUR_MS);
  const call = await prisma.incomingCall.create({
    data: {
      channelId: `test-silence-${runId}-${callIds.length}`,
      phone: `+9929000${String(callIds.length).padStart(4, "0")}`,
      startedAt,
      endedAt: new Date(startedAt.getTime() + opts.seconds * 1000),
      answered: opts.answered ?? false,
      talkSeconds: opts.answered ? opts.seconds : 0,
    },
  });
  callIds.push(call.id);
  return call;
}

async function alarmSent(tag: string): Promise<boolean> {
  const n = await prisma.notification.findFirst({ where: { tag, agentId: directorId } });
  return n !== null;
}

/** Сколько записей в журнале ошибок оставил сторож — журнал важен отдельно от
 *  пуша: пуш директор может пропустить, а журнал читают при разборе. */
async function errorLogCount(fragment: string): Promise<number> {
  return prisma.errorLog.count({ where: { source: "telephony", message: { contains: fragment } } });
}

beforeEach(async () => {
  if (!directorId) {
    const director = await prisma.agent.create({
      data: {
        fullName: "Директор теста сторожа звонков",
        phone: `+99293${runId}`,
        role: "DIRECTOR",
        passwordHash: await bcrypt.hash("x", 10),
      },
    });
    directorId = director.id;

    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { asteriskAriUrl: true, alarmHoursStart: true, alarmHoursEnd: true },
    });
    prevAriUrl = settings?.asteriskAriUrl ?? null;
    prevAlarmStart = settings?.alarmHoursStart ?? null;
    prevAlarmEnd = settings?.alarmHoursEnd ?? null;
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { asteriskAriUrl: "http://stand.local:8088/ari", alarmHoursStart: "09:00", alarmHoursEnd: "18:00" },
      create: {
        id: "singleton",
        asteriskAriUrl: "http://stand.local:8088/ari",
        alarmHoursStart: "09:00",
        alarmHoursEnd: "18:00",
      },
    });
  }
  // Дедуп сторожа живёт в Notification (shouldAlert) — каждый тест начинает с чистого листа.
  await prisma.notification.deleteMany({ where: { tag: { in: TAGS } } });
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: "Входящих звонков нет" } } });
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: "оборвались быстрее" } } });
  if (callIds.length) {
    await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
    callIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { in: TAGS } } });
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: "Входящих звонков нет" } } });
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: "оборвались быстрее" } } });
  if (callIds.length) await prisma.incomingCall.deleteMany({ where: { id: { in: callIds } } });
  if (directorId) await prisma.agent.delete({ where: { id: directorId } }).catch(() => {});
  await prisma.settings
    .update({
      where: { id: "singleton" },
      data: { asteriskAriUrl: prevAriUrl, alarmHoursStart: prevAlarmStart, alarmHoursEnd: prevAlarmEnd },
    })
    .catch(() => {});
});

describe("сторож «входящие звонки не доходят»", () => {
  it("тишина против собственной истории — тревога уходит директору и в журнал", async () => {
    // В такое же окно каждый из прошлых дней звонки были, сегодня — ни одного.
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
      await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
    }

    const { alerted, symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).toContain("silence");
    expect(alerted).toBeGreaterThanOrEqual(1);
    expect(await alarmSent("incoming-calls-silence")).toBe(true);
    expect(await errorLogCount("Входящих звонков нет")).toBeGreaterThanOrEqual(1);
  });

  it("звонки идут — тишины нет, молчим", async () => {
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
      await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
    }
    await seedCall({ hoursAgo: 1, seconds: 50, answered: true });

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).not.toContain("silence");
    expect(await alarmSent("incoming-calls-silence")).toBe(false);
  });

  it("агентство, куда и раньше не звонили, тревогу не поднимает", async () => {
    // Ни одного звонка ни сегодня, ни в прошлые дни: это не поломка, а тишина.
    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).not.toContain("silence");
    expect(await alarmSent("incoming-calls-silence")).toBe(false);
  });

  it("все звонки оборвались быстрее порога — это и есть живой случай 21.08", async () => {
    // Ровно то, как выглядела поломка: записи идут, разговора нет ни одного.
    for (let i = 0; i < 6; i++) {
      await seedCall({ hoursAgo: i + 1, seconds: 0 });
    }

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).toContain("dead-calls");
    expect(await alarmSent("incoming-calls-dead")).toBe(true);
    expect(await errorLogCount("оборвались быстрее")).toBeGreaterThanOrEqual(1);
  });

  it("хотя бы один состоявшийся разговор — обрывы это ещё не поломка приёма", async () => {
    for (let i = 0; i < 6; i++) {
      await seedCall({ hoursAgo: i + 1, seconds: 0 });
    }
    await seedCall({ hoursAgo: 2, seconds: DEAD_CALL_SECONDS + 30, answered: true });

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).not.toContain("dead-calls");
    expect(await alarmSent("incoming-calls-dead")).toBe(false);
  });

  it("длительность ровно на пороге DEAD_CALL_SECONDS уже считается состоявшимся разговором", async () => {
    // Граница строгая ( >= DEAD_CALL_SECONDS, не >): звонок ровно на пороге —
    // ещё не обрыв, а разговор, который уложился в минимальную секунду.
    for (let i = 0; i < 6; i++) {
      await seedCall({ hoursAgo: i + 1, seconds: 0 });
    }
    await seedCall({ hoursAgo: 2, seconds: DEAD_CALL_SECONDS, answered: false });

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).not.toContain("dead-calls");
    expect(await alarmSent("incoming-calls-dead")).toBe(false);
  });

  it("тревога не пишет в ленту ДВАЖДЫ за одно срабатывание (гонка с доставкой пуша)", async () => {
    // Регрессия 21.09.2026: sendPushToAgents сам пишет вторую, необожидаемую
    // копию строки в ленту тем же tag (push.ts:259) — она могла лечь уже ПОСЛЕ
    // того, как beforeEach следующего теста успевал почистить ленту, и
    // следующий, вообще не поднимавший тревогу тик видел alarmSent()===true.
    // raise() в incomingCallsSilenceAlarm.ts теперь доставляет пуш отдельно
    // (deliverPushToAgents), без повторной записи в Notification — ждём здесь
    // явно, чтобы гонка, если она вернётся, не проскочила проверку молча.
    for (let i = 0; i < 6; i++) {
      await seedCall({ hoursAgo: i + 1, seconds: 0 });
    }
    await runIncomingCallsSilenceTick(NOW);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await prisma.notification.findMany({
      where: { tag: "incoming-calls-dead", agentId: directorId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(1);
  });

  it("телефония не настроена — сторож молчит вовсе", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAriUrl: null } });
    try {
      for (let day = 1; day <= BASELINE_DAYS; day++) {
        await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
        await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
      }

      const { alerted, symptoms } = await runIncomingCallsSilenceTick(NOW);

      expect(alerted).toBe(0);
      expect(symptoms).toEqual([]);
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { asteriskAriUrl: "http://stand.local:8088/ari" },
      });
    }
  });

  it("вне часов алармов сторож молчит — директора ночью не будим", async () => {
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
    }
    // 02:00 по Душанбе того же дня.
    const night = new Date("2026-08-31T21:00:00Z");

    const { alerted, symptoms } = await runIncomingCallsSilenceTick(night);

    expect(alerted).toBe(0);
    expect(symptoms).toEqual([]);
  });

  it("повторный тик в пределах суток не дублирует тревогу", async () => {
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
      await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
    }

    await runIncomingCallsSilenceTick(NOW);
    await runIncomingCallsSilenceTick(new Date(NOW.getTime() + 60_000));

    const count = await prisma.notification.count({
      where: { tag: "incoming-calls-silence", agentId: directorId },
    });
    expect(count).toBe(1);
  });

  it("звонки ПОЗЖЕ проверяемого времени в окно не попадают", async () => {
    // Так это и вылезло: в наполненной базе лежат звонки, датированные позже
    // проверяемого момента, и окно «всё, что новее from» считало их свежими —
    // тревога не сработала бы никогда.
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
      await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
    }
    await seedCall({ hoursAgo: -48, seconds: 40, answered: true });

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).toContain("silence");
  });

  it("окно тишины — ровно SILENCE_HOURS: звонок чуть раньше его не закрывает", async () => {
    for (let day = 1; day <= BASELINE_DAYS; day++) {
      await seedCall({ hoursAgo: day * 24 + 1, seconds: 40, answered: true });
      await seedCall({ hoursAgo: day * 24 + 2, seconds: 30, answered: true });
    }
    // Последний звонок был за полчаса до начала окна — значит внутри окна пусто.
    await seedCall({ hoursAgo: SILENCE_HOURS + 0.5, seconds: 40, answered: true });

    const { symptoms } = await runIncomingCallsSilenceTick(NOW);

    expect(symptoms).toContain("silence");
  });
  // E13 (глубокая проверка 02.10.2026, решение владельца «да, по советам»):
  // тишину сравниваем ещё и с тем же днём недели неделю назад. Воскресенье или
  // праздник — звонков нет и не было, директора не будим; будний день, когда
  // неделю назад звонили, а сейчас тихо, — тревога, как раньше.
  describe("тот же день недели неделю назад (E13)", () => {
    /** Воскресенье 06.09.2026, 12:00 по Душанбе (07:00 UTC). */
    const SUNDAY = new Date("2026-09-06T07:00:00Z");

    /** Звонки в том же окне суток в дни 1..BASELINE_DAYS назад, кроме перечисленных. */
    async function seedWeek(from: Date, perDay: Record<number, number>) {
      for (let day = 1; day <= BASELINE_DAYS; day++) {
        const n = perDay[day] ?? 2;
        for (let i = 0; i < n; i++) {
          await seedCall({ from, hoursAgo: day * 24 + 1 + i * 0.5, seconds: 40, answered: true });
        }
      }
    }

    it("воскресенье: в будни звонили, а прошлое воскресенье в эти часы было тихим — тревоги нет", async () => {
      await seedWeek(SUNDAY, { 7: 0 });

      const { alerted, symptoms } = await runIncomingCallsSilenceTick(SUNDAY);

      expect(symptoms).not.toContain("silence");
      expect(alerted).toBe(0);
      expect(await alarmSent("incoming-calls-silence")).toBe(false);
      expect(await errorLogCount("Входящих звонков нет")).toBe(0);
    });

    it("«почти не было» неделю назад (не больше SAME_WEEKDAY_QUIET_MAX) — тоже тихий день, молчим", async () => {
      await seedWeek(SUNDAY, { 7: SAME_WEEKDAY_QUIET_MAX });

      const { symptoms } = await runIncomingCallsSilenceTick(SUNDAY);

      expect(symptoms).not.toContain("silence");
      expect(await alarmSent("incoming-calls-silence")).toBe(false);
    });

    it("неделю назад в тот же день и часы звонили, сейчас тихо — тревога, как раньше", async () => {
      await seedWeek(SUNDAY, { 7: SAME_WEEKDAY_QUIET_MAX + 2 });

      const { symptoms } = await runIncomingCallsSilenceTick(SUNDAY);

      expect(symptoms).toContain("silence");
      expect(await alarmSent("incoming-calls-silence")).toBe(true);
      expect(await errorLogCount("Неделю назад в этот же день")).toBeGreaterThanOrEqual(1);
    });

    it("день недели считается по Душанбе: понедельник 04:00 там — ещё воскресенье по UTC", async () => {
      // 07.09.2026 04:00 по Душанбе = 06.09 23:00 UTC. Неделю назад в тот же
      // ДУШАНБИНСКИЙ понедельник звонили — тревога; прошлое воскресенье (то,
      // что вышло бы, если считать день недели по UTC) было бы пустым.
      const mondayEarly = new Date("2026-09-06T23:00:00Z");
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { alarmHoursStart: "00:00", alarmHoursEnd: "23:59" },
      });
      try {
        await seedWeek(mondayEarly, { 7: 3 });

        const { symptoms } = await runIncomingCallsSilenceTick(mondayEarly);

        expect(symptoms).toContain("silence");
      } finally {
        await prisma.settings.update({
          where: { id: "singleton" },
          data: { alarmHoursStart: "09:00", alarmHoursEnd: "18:00" },
        });
      }
    });
  });
});
