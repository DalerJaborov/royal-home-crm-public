import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПОТОЛОК МИНУТ РОБОТА (П5, 11.11.2026). Владелец: «чтобы … звонков вдруг не отключиться
 * и у нас деньги пойдут в минус». Каждая проверка здесь падает на коде до правки:
 *  - минуты считаются по LiveVoiceSession поставщика elevenlabs, незакрытая — до сейчас,
 *    не дольше потолка одного звонка;
 *  - на 80% и 100% — одна тревога директору на порог за период, повтор не ставится;
 *  - дошли до потолка — дверь «можно ли звонить роботом» отвечает «перенести», входящие
 *    держит та же проверка «у ElevenLabs нет минут», проверочный звонок не держится;
 *  - 0 — без потолка; голос Google — потолок ElevenLabs не держит;
 *  - сбой базы при подсчёте — отказ «попробуйте позже», а не «звоните»;
 *  - предохранитель: не больше ROBOT_CALL_DAILY_SESSIONS_FUSE поднятых звонков на номер
 *    в сутки, даже если все они — автоответчик (частота разговоров их не считает).
 * Время задано явно (`now`) далеко в будущем: строки других тестов в счёт не попадают.
 */

vi.mock("../src/lib/telephony/stationBlacklist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/stationBlacklist.js")>()),
  isNumberBlocked: vi.fn(async () => ({ ok: true as const, blocked: false })),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { robotCallAllowed, robotCallPhoneKey } = await import("../src/lib/robotCallPolicy.js");
const spend = await import("../src/lib/liveVoiceSpend.js");
const { elevenLabsQuotaExhausted } = await import("../src/ai/liveVoiceProvider.js");
const shared = await import("@royal-home/shared");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
const CHANNEL = `lv-spend-${runId}`;
const MIN = 60_000;

/** Момент по Душанбе (UTC+5). */
function dushanbe(day: string, hh: number, mm = 0): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm));
}

// Вторник далеко впереди: сессии других тестов (сегодняшние) в этот месяц не попадают.
const DAY = "2031-03-11";
const NOW = dushanbe(DAY, 12);

let seq = 0;
async function session(input: { startedAt: Date; minutes?: number | null; provider?: string; direction?: string; phone?: string; transcript?: string }) {
  seq += 1;
  return prisma.liveVoiceSession.create({
    data: {
      channelId: `${CHANNEL}-${seq}`,
      provider: input.provider ?? "elevenlabs",
      direction: input.direction ?? "inbound",
      callerNumber: input.phone ?? null,
      startedAt: input.startedAt,
      endedAt: input.minutes === null ? null : new Date(input.startedAt.getTime() + (input.minutes ?? 1) * MIN),
      endedReason: input.minutes === null ? null : "channel_ended",
      transcript: input.transcript ?? null,
    },
  });
}

function freshPhone(): string {
  return `93${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
}

type SettingsBackup = {
  liveVoiceProvider: string;
  liveVoiceDailyMinutesCap: number;
  liveVoiceMonthlyMinutesCap: number;
  companyHolidays: string[];
  companyDaysOff: number[];
};
let settingsBefore: SettingsBackup | null = null;

async function setSettings(data: Partial<SettingsBackup>) {
  await prisma.settings.update({ where: { id: "singleton" }, data });
}

const spendAlerts = () =>
  prisma.pendingDirectorAlert.findMany({ where: { tag: { startsWith: "live-voice-spend:", contains: "2031-" } }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  settingsBefore = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceProvider: true, liveVoiceDailyMinutesCap: true, liveVoiceMonthlyMinutesCap: true, companyHolidays: true, companyDaysOff: true },
  });
  await setSettings({ liveVoiceProvider: "elevenlabs", liveVoiceDailyMinutesCap: 10, liveVoiceMonthlyMinutesCap: 100, companyHolidays: [], companyDaysOff: [] });
});

afterAll(async () => {
  if (settingsBefore) await setSettings(settingsBefore);
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: CHANNEL } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "live-voice-spend:", contains: "2031-" } } });
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "live-voice-spend:", contains: "2031-" } } });
  spend.resetLiveVoiceSpendAlertsForTests();
});

describe("потолок минут: чистая часть", () => {
  it("сессия засчитывается от начала до конца, идущая — до сейчас, не дольше потолка звонка", () => {
    const at = new Date("2031-03-11T07:00:00Z");
    expect(shared.liveVoiceSessionBilledMs({ startedAt: at, endedAt: new Date(at.getTime() + 2 * MIN) }, NOW)).toBe(2 * MIN);
    expect(shared.liveVoiceSessionBilledMs({ startedAt: new Date(NOW.getTime() - 3 * MIN), endedAt: null }, NOW)).toBe(3 * MIN);
    // Зависшая строка без конца (процесс упал) — не больше 15 минут: дольше мост звонок не держит.
    expect(shared.liveVoiceSessionBilledMs({ startedAt: new Date(NOW.getTime() - 5 * 3600_000), endedAt: null }, NOW)).toBe(15 * MIN);
    expect(shared.liveVoiceSessionBilledMs({ startedAt: at, endedAt: new Date(at.getTime() - MIN) }, NOW)).toBe(0);
  });

  it("потолок в учёте совпадает с потолком одного звонка в мосте", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/lib/telephony/liveVoiceBridge.ts"), "utf8");
    const m = src.match(/const LIVE_VOICE_MAX_SESSION_MS = (\d+) \* 60_000;/);
    expect(m, "в мосте не найден LIVE_VOICE_MAX_SESSION_MS").not.toBeNull();
    expect(Number(m![1]) * MIN).toBe(shared.LIVE_VOICE_SESSION_BILLING_CAP_MS);
  });

  it("0 — без потолка; дробь, минус, null и лишний ноль — значение по умолчанию", () => {
    expect(shared.liveVoiceMinutesCapOrDefault(0, 30)).toBe(0);
    expect(shared.liveVoiceMinutesCapOrDefault(45, 30)).toBe(45);
    for (const bad of [null, undefined, -1, 1.5, shared.LIVE_VOICE_MINUTES_CAP_MAX + 1]) {
      expect(shared.liveVoiceMinutesCapOrDefault(bad as number | null | undefined, 30)).toBe(30);
    }
  });

  it("решение и пороги: 79% — тихо, 80% — предупреждение, 100% — пауза; месяц важнее суток", () => {
    const at = (dayMin: number, monthMin: number, dailyCap = 10, monthlyCap = 100) =>
      shared.evaluateLiveVoiceSpend({ now: NOW, dayMs: dayMin * MIN, monthMs: monthMin * MIN, dailyCap, monthlyCap });
    expect(shared.liveVoiceSpendThresholdsReached(at(7.9, 7.9).day)).toEqual([]);
    expect(shared.liveVoiceSpendThresholdsReached(at(8, 8).day)).toEqual([80]);
    expect(at(8, 8).held).toBeNull();
    expect(shared.liveVoiceSpendThresholdsReached(at(10, 10).day)).toEqual([80, 100]);
    expect(at(10, 10).held).toBe("day");
    expect(at(10, 100).held).toBe("month");
    expect(at(10, 100, 0, 0).held).toBeNull();
    expect(at(10, 100, 0, 0).day.percent).toBeNull();
    expect(at(8, 8).day.key).toBe(DAY);
    expect(at(8, 8).month.key).toBe("2031-03");
  });

  it("конец периода по Душанбе: сутки — полночь, месяц — 1-е число, и через Новый год", () => {
    expect(spend.liveVoiceSpendPeriodEnd("day", NOW).toISOString()).toBe("2031-03-11T19:00:00.000Z");
    expect(spend.liveVoiceSpendPeriodEnd("month", NOW).toISOString()).toBe("2031-03-31T19:00:00.000Z");
    // 31.12 23:30 по Душанбе — ещё декабрь; 01.01 00:30 — уже январь.
    expect(spend.liveVoiceSpendPeriodEnd("month", dushanbe("2030-12-31", 23, 30)).toISOString()).toBe("2030-12-31T19:00:00.000Z");
    expect(spend.liveVoiceSpendPeriodEnd("month", dushanbe("2031-01-01", 0, 30)).toISOString()).toBe("2031-01-31T19:00:00.000Z");
  });

  it("текст тревоги говорит, сколько наговорено, что с роботом и где поднять потолок", () => {
    const state = shared.evaluateLiveVoiceSpend({ now: NOW, dayMs: 10 * MIN, monthMs: 10 * MIN, dailyCap: 10, monthlyCap: 100 });
    const stop = spend.liveVoiceSpendAlertText("day", state.day, 100);
    expect(stop.title).toMatch(/остановлен до завтра/);
    expect(stop.body).toMatch(/10 из 10 мин/);
    expect(stop.body).toMatch(/идущий разговор не прерывается/);
    expect(stop.body).toMatch(/Настройки/);
    expect(spend.liveVoiceSpendAlertText("month", state.month, 80).body).toMatch(/до следующего месяца/);
  });
});

describe("потолок минут: учёт по базе, тревоги, дверь и входящие", () => {
  beforeEach(async () => {
    await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: CHANNEL } } });
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "live-voice-spend:", contains: "2031-" } } });
    spend.resetLiveVoiceSpendAlertsForTests();
    await setSettings({ liveVoiceProvider: "elevenlabs", liveVoiceDailyMinutesCap: 10, liveVoiceMonthlyMinutesCap: 100 });
  });

  it("80%: одна тревога на порог за сутки, повторный подсчёт второй не ставит; робот звонит", async () => {
    await session({ startedAt: dushanbe(DAY, 9), minutes: 5 });
    await session({ startedAt: dushanbe(DAY, 10), minutes: 3 });
    // Вчерашняя (этот же месяц) и чужой поставщик в сутки не идут.
    await session({ startedAt: dushanbe("2031-03-10", 15), minutes: 9 });
    await session({ startedAt: dushanbe(DAY, 11), minutes: 9, provider: "google" });

    const first = await spend.refreshLiveVoiceSpend(NOW);
    expect(first.day).toMatchObject({ usedMinutes: 8, capMinutes: 10, percent: 80, reached: false });
    expect(first.month.usedMinutes).toBe(17);
    expect(first.held).toBeNull();
    await spend.refreshLiveVoiceSpend(NOW);
    spend.resetLiveVoiceSpendAlertsForTests(); // как после перезапуска процесса: память пуста, база помнит
    await spend.refreshLiveVoiceSpend(NOW);

    const alerts = await spendAlerts();
    expect(alerts.map((a) => a.tag)).toEqual([`live-voice-spend:day:80:${DAY}`]);
    expect(alerts[0]).toMatchObject({ level: "CRITICAL", kind: "oversight" });
    expect(alerts[0].recipientRoles.sort()).toEqual(["ADMIN", "DIRECTOR"]);
    expect(elevenLabsQuotaExhausted()).toBe(false);
    const decision = await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW });
    expect(decision.allowed).toBe(true);
  });

  it("100%: робот на паузе до завтра — исходящий «перенести», входящий не берётся, проверочный звонок идёт", async () => {
    await session({ startedAt: dushanbe(DAY, 9), minutes: 7 });
    // Идёт прямо сейчас (конца нет) — засчитывается до сейчас: 3 минуты.
    await session({ startedAt: new Date(NOW.getTime() - 3 * MIN), minutes: null });

    const decision = await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW });
    expect(decision).toMatchObject({ allowed: false, code: "minutes_cap_day", defer: true });
    if (decision.allowed) throw new Error("ожидался отказ");
    expect(decision.retryAt?.toISOString()).toBe(dushanbe("2031-03-12", 9).toISOString());
    expect(decision.message).toMatch(/дневной потолок минут/);
    // Входящие: та же дверь «у ElevenLabs нет минут», что у моста.
    expect(elevenLabsQuotaExhausted()).toBe(true);
    // Карточка клиента тоже держится, проверочный — нет.
    expect(await robotCallAllowed({ phone: freshPhone(), kind: "client_card", now: NOW })).toMatchObject({ allowed: false, code: "minutes_cap_day" });
    expect(await robotCallAllowed({ phone: freshPhone(), kind: "test", now: NOW })).toEqual({ allowed: true });

    await spend.refreshLiveVoiceSpend(NOW);
    const tags = (await spendAlerts()).map((a) => a.tag);
    // Перескочили 80% разом до 100% — одна тревога «остановлен», а не две.
    expect(tags).toEqual([`live-voice-spend:day:100:${DAY}`]);
  });

  it("владелец поднял потолок до 0 («без потолка») — пауза снимается сразу", async () => {
    await session({ startedAt: dushanbe(DAY, 9), minutes: 12 });
    await spend.refreshLiveVoiceSpend(NOW);
    expect(elevenLabsQuotaExhausted()).toBe(true);
    await setSettings({ liveVoiceDailyMinutesCap: 0 });
    const after = await spend.refreshLiveVoiceSpend(NOW);
    expect(after.held).toBeNull();
    expect(after.day.capMinutes).toBe(0);
    expect(elevenLabsQuotaExhausted()).toBe(false);
    expect((await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW })).allowed).toBe(true);
  });

  it("месячный потолок: пауза до начала окна звонков 1-го числа следующего месяца", async () => {
    await setSettings({ liveVoiceDailyMinutesCap: 0, liveVoiceMonthlyMinutesCap: 12 });
    await session({ startedAt: dushanbe("2031-03-02", 10), minutes: 13 });
    const decision = await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW });
    expect(decision).toMatchObject({ allowed: false, code: "minutes_cap_month", defer: true });
    if (decision.allowed) throw new Error("ожидался отказ");
    expect(decision.retryAt?.toISOString()).toBe(dushanbe("2031-04-01", 9).toISOString());
    expect((await spendAlerts()).map((a) => a.tag)).toEqual(["live-voice-spend:month:100:2031-03"]);
  });

  it("голос робота — Google: минуты ElevenLabs робота не держат", async () => {
    await session({ startedAt: dushanbe(DAY, 9), minutes: 12 });
    await setSettings({ liveVoiceProvider: "google" });
    const reading = await spend.refreshLiveVoiceSpend(NOW);
    expect(reading.held).toBeNull();
    expect(reading.day.reached).toBe(true); // для экрана счёт честный
    expect(elevenLabsQuotaExhausted()).toBe(false);
    expect((await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW })).allowed).toBe(true);
    expect(await spendAlerts()).toEqual([]);
  });

  it("база не ответила при подсчёте — «попробуйте позже», а не «звоните»", async () => {
    const spy = vi.spyOn(prisma.liveVoiceSession, "findMany").mockRejectedValueOnce(new Error("база недоступна"));
    try {
      const decision = await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW });
      expect(decision).toMatchObject({ allowed: false, code: "policy_unavailable", defer: true });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("предохранитель наборов на один номер", () => {
  beforeEach(async () => {
    await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: CHANNEL } } });
    // Голос Google: потолок минут здесь ни при чём.
    await setSettings({ liveVoiceProvider: "google" });
  });

  it(`${shared.ROBOT_CALL_DAILY_SESSIONS_FUSE} поднятых звонка за сутки (все — автоответчик) — следующий завтра; приглашение тоже держится`, async () => {
    const phone = freshPhone();
    const key = robotCallPhoneKey(phone);
    const voicemail = "Робот: Здравствуйте!\nКлиент: Абонент не может ответить, оставьте сообщение после сигнала";
    for (let i = 0; i < shared.ROBOT_CALL_DAILY_SESSIONS_FUSE - 1; i++) {
      await session({ startedAt: dushanbe(DAY, 9, i * 10), minutes: 1, direction: "outbound", phone: key, transcript: voicemail });
    }
    // Автоответчик частоту разговоров не тратит — ещё можно.
    expect((await robotCallAllowed({ phone, kind: "scenario", now: NOW })).allowed).toBe(true);

    await session({ startedAt: dushanbe(DAY, 10), minutes: 1, direction: "outbound", phone: key, transcript: voicemail });
    const decision = await robotCallAllowed({ phone, kind: "scenario", now: NOW });
    expect(decision).toMatchObject({ allowed: false, code: "daily_sessions_fuse", defer: true });
    if (decision.allowed) throw new Error("ожидался отказ");
    expect(decision.retryAt?.toISOString()).toBe(dushanbe("2031-03-12", 9).toISOString());
    expect(await robotCallAllowed({ phone, kind: "scenario", purpose: "interview_invite", now: NOW })).toMatchObject({ allowed: false, code: "daily_sessions_fuse" });
    // Проверочный звонок владельца предохранитель не держит; другой номер — тоже свободен.
    expect(await robotCallAllowed({ phone, kind: "test", now: NOW })).toEqual({ allowed: true });
    expect((await robotCallAllowed({ phone: freshPhone(), kind: "scenario", now: NOW })).allowed).toBe(true);
    // Назавтра счёт с нуля.
    expect((await robotCallAllowed({ phone, kind: "scenario", now: dushanbe("2031-03-12", 12) })).allowed).toBe(true);
  });
});

describe("Настройки: потолок минут и расход на экране", () => {
  const password = "testpass123";
  let token = "";
  let directorId = "";

  beforeAll(async () => {
    const phone = `+992987${String(Date.now()).slice(-7)}`;
    directorId = (
      await prisma.agent.create({ data: { fullName: "Директор потолка минут", phone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) } })
    ).id;
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    grantElevation(directorId);
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await deleteAgentsWithTraces([directorId]);
  });

  it("PATCH сохраняет потолки (0 — без потолка), отрицательное и дробь — 400; GET отдаёт расход", async () => {
    const ok = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send({ liveVoiceDailyMinutesCap: 0, liveVoiceMonthlyMinutesCap: 240 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ liveVoiceDailyMinutesCap: 0, liveVoiceMonthlyMinutesCap: 240 });
    expect(ok.body.liveVoiceSpend).toMatchObject({ day: { capMinutes: 0, percent: null }, month: { capMinutes: 240 } });

    for (const bad of [{ liveVoiceDailyMinutesCap: -1 }, { liveVoiceMonthlyMinutesCap: 1.5 }, { liveVoiceDailyMinutesCap: shared.LIVE_VOICE_MINUTES_CAP_MAX + 1 }]) {
      const res = await request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const got = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body.liveVoiceMonthlyMinutesCap).toBe(240);
    expect(got.body.liveVoiceSpend.month).toHaveProperty("usedMinutes");
  });
});
