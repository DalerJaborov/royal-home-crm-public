import { randomInt } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОДНА ДВЕРЬ «МОЖНО ЛИ ЗВОНИТЬ РОБОТОМ» (П3, 11.11.2026).
 *
 * Время задаётся явно (`now`), а через мост — подменой часов (только Date), поэтому
 * файл зелёный в любой час суток: часы звонков робота 09:00–19:00 по Душанбе.
 */

const blacklisted = new Set<string>();
vi.mock("../src/lib/telephony/stationBlacklist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/stationBlacklist.js")>()),
  isNumberBlocked: vi.fn(async (phone: string) => ({ ok: true as const, blocked: blacklisted.has(phone.replace(/\D/g, "").slice(-9)) })),
}));

const originateToStasisApp = vi.fn(async () => ({ ok: true, channelId: `lv-policy-${Date.now()}` }));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp,
}));

const { prisma } = await import("../src/db.js");
const { robotCallAllowed, setRobotCallStop, clearRobotCallStop } = await import("../src/lib/robotCallPolicy.js");
const { originateLiveVoiceCallToClient, originateLiveVoiceTestCall } = await import("../src/lib/telephony/liveVoiceBridge.js");
const { ROBOT_CALL_DAY_START_HOUR, ROBOT_CALL_DAY_END_HOUR, robotCallWindowRefusal, nextRobotCallWindowStart } = await import("@royal-home/shared");
const { POST_SHOWING_CALL_DAY_START_HOUR, POST_SHOWING_CALL_DAY_END_HOUR } = await import("../src/lib/postShowingCall.js");

/** Момент по Душанбе: «2026-11-11» + час:минуты (UTC+5). */
function dushanbe(day: string, hh: number, mm = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm));
}

/** Свободный номер: девять цифр, своя полоса 93…, по одному на тест. */
const used: string[] = [];
function freshPhone(): string {
  const local = `93${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
  used.push(local);
  return local;
}

// Среда, обычный рабочий день (общих выходных в тестовой базе по умолчанию нет).
const DAY = "2026-11-11";
let settingsBefore: { companyHolidays: string[]; robotCallDailyMaxPerNumber: number; robotCallWeeklyMaxPerNumber: number; liveVoiceEnabled: boolean } | null = null;
const portBefore = process.env.LIVE_VOICE_RTP_PORT;
const hostBefore = process.env.LIVE_VOICE_RTP_HOST;
let clientId = "";
let clientPhone = "";

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_PORT = "40810";
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { companyHolidays: true, robotCallDailyMaxPerNumber: true, robotCallWeeklyMaxPerNumber: true, liveVoiceEnabled: true },
  });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { companyHolidays: [], robotCallDailyMaxPerNumber: 1, robotCallWeeklyMaxPerNumber: 3, liveVoiceEnabled: true },
  });
  clientPhone = freshPhone();
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент политики робота ${clientPhone}`, phone: `+992${clientPhone}`, source: "PHONE_CALL", acceptedAt: new Date() },
    })
  ).id;
});

afterEach(() => {
  vi.useRealTimers();
  blacklisted.clear();
});

afterAll(async () => {
  if (portBefore === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
  else process.env.LIVE_VOICE_RTP_PORT = portBefore;
  if (hostBefore === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
  else process.env.LIVE_VOICE_RTP_HOST = hostBefore;
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  await prisma.liveVoiceSession.deleteMany({ where: { callerNumber: { in: used } } });
  await prisma.robotCallStop.deleteMany({ where: { phone: { in: used } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
});

async function outboundSession(phone: string, startedAt: Date, direction = "outbound") {
  await prisma.liveVoiceSession.create({ data: { channelId: `policy-${phone}-${startedAt.getTime()}`, startedAt, direction, callerNumber: phone } });
}

describe("часы, выходные и праздники по Душанбе", () => {
  it("часы двери совпадают с часами опроса после показа (одно окно на всех)", () => {
    expect([ROBOT_CALL_DAY_START_HOUR, ROBOT_CALL_DAY_END_HOUR]).toEqual([POST_SHOWING_CALL_DAY_START_HOUR, POST_SHOWING_CALL_DAY_END_HOUR]);
  });

  it("звонок по карточке в 23:00 — отказ «перенести» с временем следующего окна", async () => {
    const decision = await robotCallAllowed({ phone: freshPhone(), kind: "client_card", now: dushanbe(DAY, 23) });
    expect(decision).toMatchObject({ allowed: false, code: "outside_hours", defer: true });
    expect(decision.allowed === false && decision.retryAt?.toISOString()).toBe(dushanbe("2026-11-12", 9).toISOString());
  });

  it("в 23:00 через мост — отказ без единого Originate, причина словами", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dushanbe(DAY, 23));
    originateToStasisApp.mockClear();
    const result = await originateLiveVoiceCallToClient({ id: clientId, phone: `+992${clientPhone}`, fullName: "Клиент" });
    expect(result).toMatchObject({ ok: false, busy: true, notDialed: true });
    expect(result.error).toMatch(/09:00 до 19:00/);
    expect(originateToStasisApp).not.toHaveBeenCalled();
  });

  it("в праздник — отказ, назавтра — можно", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyHolidays: [DAY] } });
    try {
      const phone = freshPhone();
      expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 12) })).toMatchObject({ allowed: false, code: "holiday", defer: true });
      expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe("2026-11-12", 12) })).toEqual({ allowed: true });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyHolidays: [] } });
    }
  });

  it("граница праздника — полночь по Душанбе, а не по UTC", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { companyHolidays: ["2026-11-12"] } });
    try {
      // 12.11 01:00 по Душанбе — это ещё 11.11 по UTC, но уже праздник.
      const decision = await robotCallAllowed({ phone: freshPhone(), kind: "test", now: dushanbe("2026-11-12", 1) });
      expect(decision).toEqual({ allowed: true }); // проверочному праздник не помеха
      expect(await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: dushanbe("2026-11-12", 1) })).toMatchObject({ code: "holiday" });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { companyHolidays: [] } });
    }
  });

  it("общий выходной компании — отказ (чистое правило, общие Настройки не трогаем)", () => {
    // 11.11.2026 — среда (3).
    expect(robotCallWindowRefusal(dushanbe(DAY, 12), { companyDaysOff: [3] })).toBe("day_off");
    expect(nextRobotCallWindowStart(dushanbe(DAY, 12), { companyDaysOff: [3], companyHolidays: ["2026-11-12"] }).toISOString()).toBe(
      dushanbe("2026-11-13", 9).toISOString()
    );
  });

  it("проверочный звонок в 23:00 — разрешён (часы ему не помеха)", async () => {
    expect(await robotCallAllowed({ phone: freshPhone(), kind: "test", now: dushanbe(DAY, 23) })).toEqual({ allowed: true });
  });
});

describe("единый «не звонить роботом»", () => {
  it("стоп по номеру ловит тот же номер в другой записи; снятый стоп — снова можно", async () => {
    const phone = freshPhone();
    const now = dushanbe(DAY, 12);
    await setRobotCallStop({ phone: `+992 ${phone.slice(0, 2)} ${phone.slice(2)}`, source: "STAFF" });
    for (const form of [phone, `0${phone}`, `+992${phone}`, `992-${phone}`]) {
      expect(await robotCallAllowed({ phone: form, kind: "scenario", now })).toMatchObject({ allowed: false, code: "stopped", defer: false });
    }
    // Проверочному звонку запрет человека тоже не обойти.
    expect(await robotCallAllowed({ phone, kind: "test", now })).toMatchObject({ code: "stopped" });
    expect(await clearRobotCallStop({ phone, clearedByAgentId: null })).toBe(1);
    expect(await robotCallAllowed({ phone, kind: "scenario", now })).toEqual({ allowed: true });
  });

  it("стоп по карточке ловит звонок на другой номер того же клиента", async () => {
    await setRobotCallStop({ phone: `+992${clientPhone}`, clientId, source: "STAFF" });
    try {
      expect(await robotCallAllowed({ phone: freshPhone(), clientId, kind: "scenario", now: dushanbe(DAY, 12) })).toMatchObject({ code: "stopped" });
    } finally {
      await clearRobotCallStop({ phone: `+992${clientPhone}`, clientId, clearedByAgentId: null });
    }
  });

  it("повторная постановка не плодит записей", async () => {
    const phone = freshPhone();
    const first = await setRobotCallStop({ phone, source: "STAFF" });
    const [second, third] = await Promise.all([setRobotCallStop({ phone: `0${phone}`, source: "VOICE" }), setRobotCallStop({ phone, source: "STAFF" })]);
    expect(first.created).toBe(true);
    expect(second.created || third.created).toBe(false);
    expect(await prisma.robotCallStop.count({ where: { phone, clearedAt: null } })).toBe(1);
  });

  it("«не беспокойте» в переписке — отказ и без отметки", async () => {
    const phone = freshPhone();
    const c = await prisma.client.create({ data: { fullName: `Не беспокоить ${phone}`, phone: `+992${phone}`, source: "PHONE_CALL" } });
    const conv = await prisma.botConversation.create({
      data: { channel: "whatsapp", subscriberId: `policy-${phone}`, clientId: c.id, optedOutAt: new Date() },
    });
    try {
      expect(await robotCallAllowed({ phone, clientId: c.id, kind: "scenario", now: dushanbe(DAY, 12) })).toMatchObject({ code: "opted_out", defer: false });
      // Вызывающий карточку не назвал (приглашение, рекрутинг) — найдётся по номеру.
      expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 12) })).toMatchObject({ code: "opted_out" });
    } finally {
      await prisma.botConversation.delete({ where: { id: conv.id } });
      await prisma.client.delete({ where: { id: c.id } });
    }
  });

  it("чёрный список станции — отказ", async () => {
    const phone = freshPhone();
    blacklisted.add(phone);
    expect(await robotCallAllowed({ phone: `+992${phone}`, kind: "scenario", now: dushanbe(DAY, 12) })).toMatchObject({ code: "blacklisted", defer: false });
  });

  it("через мост: стоп по номеру — отказ без Originate и без «занято»", async () => {
    const phone = freshPhone();
    await setRobotCallStop({ phone, source: "STAFF" });
    originateToStasisApp.mockClear();
    const result = await originateLiveVoiceTestCall(`+992${phone}`);
    expect(result).toMatchObject({ ok: false, notDialed: true });
    expect(result.busy).toBeUndefined();
    expect(originateToStasisApp).not.toHaveBeenCalled();
  });
});

describe("частота на номер — по всем видам вместе", () => {
  it("второй разговор за сутки — отказ до завтрашнего утра", async () => {
    const phone = freshPhone();
    await outboundSession(phone, dushanbe(DAY, 10));
    const decision = await robotCallAllowed({ phone, kind: "client_card", now: dushanbe(DAY, 15) });
    expect(decision).toMatchObject({ allowed: false, code: "daily_limit", defer: true });
    expect(decision.allowed === false && decision.retryAt?.toISOString()).toBe(dushanbe("2026-11-12", 9).toISOString());
  });

  it("граница суток — по Душанбе: разговор в 00:30 по Душанбе (вчера по UTC) считается сегодняшним", async () => {
    const phone = freshPhone();
    await outboundSession(phone, dushanbe(DAY, 0, 30));
    expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 10) })).toMatchObject({ code: "daily_limit" });
    const other = freshPhone();
    await outboundSession(other, dushanbe("2026-11-10", 23, 30)); // вчера по Душанбе
    expect(await robotCallAllowed({ phone: other, kind: "scenario", now: dushanbe(DAY, 10) })).toEqual({ allowed: true });
  });

  it("четвёртый за семь суток — отказ; разговор восьмидневной давности не в счёт", async () => {
    const phone = freshPhone();
    for (const d of ["2026-11-05", "2026-11-07", "2026-11-09"]) await outboundSession(phone, dushanbe(d, 12));
    const decision = await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 12) });
    expect(decision).toMatchObject({ code: "weekly_limit", defer: true });
    // Освободится, когда 05.11 выпадет из семи суток: 12.11 с утра.
    expect(decision.allowed === false && decision.retryAt?.toISOString()).toBe(dushanbe("2026-11-12", 9).toISOString());

    const older = freshPhone();
    for (const d of ["2026-11-04", "2026-11-07", "2026-11-09"]) await outboundSession(older, dushanbe(d, 12));
    expect(await robotCallAllowed({ phone: older, kind: "scenario", now: dushanbe(DAY, 12) })).toEqual({ allowed: true });
  });

  it("входящие и проверочные разговоры частоту не тратят; проверочному частота не помеха", async () => {
    const phone = freshPhone();
    await outboundSession(phone, dushanbe(DAY, 10), "inbound");
    await outboundSession(phone, dushanbe(DAY, 11), "test");
    expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 12) })).toEqual({ allowed: true });
    await outboundSession(phone, dushanbe(DAY, 12));
    expect(await robotCallAllowed({ phone, kind: "test", now: dushanbe(DAY, 13) })).toEqual({ allowed: true });
  });

  it("числа берутся из Настроек", async () => {
    const phone = freshPhone();
    await outboundSession(phone, dushanbe(DAY, 10));
    await prisma.settings.update({ where: { id: "singleton" }, data: { robotCallDailyMaxPerNumber: 2 } });
    try {
      expect(await robotCallAllowed({ phone, kind: "scenario", now: dushanbe(DAY, 12) })).toEqual({ allowed: true });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { robotCallDailyMaxPerNumber: 1 } });
    }
  });
});

describe("номер", () => {
  it("не таджикский номер — окончательный отказ", async () => {
    expect(await robotCallAllowed({ phone: "+7 999 123", kind: "test" })).toMatchObject({ code: "invalid_number", defer: false });
  });
});
