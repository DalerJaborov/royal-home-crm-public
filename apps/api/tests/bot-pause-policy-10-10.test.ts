import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ПАУЗА БОТА «НА 10 ЛЕТ» И СТОРОЖ ПАУЗ (аудит ботов 10.10.2026, P0-3,
 * docs/audit-bots-2026-10-10-real-failures.md).
 *
 * 132 диалога на паузе после ответа оператора (OPERATOR_REPLY_PAUSE_MS = 10 лет),
 * в 35 последним писал клиент. Сторож пауз (lib/botPauseWatch.ts) на проде
 * выключен (Settings.botPauseWatchEnabled = false) — здесь проверяем, что он
 * готов к включению и безопасен, и что заготовленный конечный срок паузы
 * (lib/conversationState.ts::OPERATOR_PAUSE_POLICY) выключен по умолчанию и
 * работает, когда его включат.
 */

const { prisma } = await import("../src/db.js");
const { OPERATOR_PAUSE_POLICY, isOperatorPauseActive, operatorPauseExpired } = await import(
  "../src/lib/conversationState.js"
);
const { runBotPauseWatchTick } = await import("../src/lib/botPauseWatch.js");

const HOUR = 3_600_000;

describe("конечный срок паузы оператора — заготовлен, выключен", () => {
  it("по умолчанию выключен: поведение прежнее, пауза держит бота сколько угодно", async () => {
    expect(OPERATOR_PAUSE_POLICY.enabled).toBe(false);
    expect(OPERATOR_PAUSE_POLICY.hours).toBe(48);
    const tenYears = new Date(Date.now() + 10 * 365 * 24 * HOUR);
    const longAgo = new Date(Date.now() - 30 * 24 * HOUR);
    expect(operatorPauseExpired(longAgo)).toBe(false);
    expect(await isOperatorPauseActive(tenYears, longAgo, null)).toBe(true);
  });

  it("включённая политика: через 48 ч после последнего ответа оператора пауза бота не держит", async () => {
    const on = { enabled: true, hours: 48 };
    const tenYears = new Date(Date.now() + 10 * 365 * 24 * HOUR);
    expect(await isOperatorPauseActive(tenYears, new Date(Date.now() - 49 * HOUR), null, on)).toBe(false);
    // Оператор писал 47 ч назад — пауза ещё действует.
    expect(await isOperatorPauseActive(tenYears, new Date(Date.now() - 47 * HOUR), null, on)).toBe(true);
    // Без отметки начала паузы срок не считаем — не снимаем наугад.
    expect(await isOperatorPauseActive(tenYears, null, null, on)).toBe(true);
    expect(operatorPauseExpired(new Date(0), { enabled: true, hours: 0 })).toBe(false);
  });
});

describe("сторож пауз готов к включению", () => {
  const runId = Date.now().toString(36);
  /** «Сейчас» сторожа — в 2001 году: тик видит только наши строки, чужие тесты не задевает. */
  const now = new Date("2001-01-10T12:00:00Z");
  const far = new Date(Date.now() + 10 * 365 * 24 * HOUR);
  let saved: { botPauseWatchEnabled: boolean; botPauseAlertHours: number; botPauseEscalateHours: number };
  const ids: Record<string, string> = {};

  async function conv(key: string, lastRole: "user" | "assistant", waitedHours: number, extra: Record<string, unknown> = {}) {
    const row = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `pause-watch-${runId}-${key}`,
        messages: [
          { role: "user", content: "Салом, хона мехоҳам" },
          { role: lastRole, content: lastRole === "user" ? "Алло, ҷавоб диҳед" : "Агент ба шумо менависад" },
        ] as any,
        lastMessageAt: new Date(now.getTime() - waitedHours * HOUR),
        pausedUntil: far,
        botPausedAt: new Date(now.getTime() - (waitedHours + 1) * HOUR),
        ...extra,
      },
    });
    ids[key] = row.id;
  }

  const pausedUntilOf = async (key: string) =>
    (await prisma.botConversation.findUnique({ where: { id: ids[key] }, select: { pausedUntil: true } }))?.pausedUntil ?? null;

  beforeAll(async () => {
    saved = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: { botPauseWatchEnabled: true, botPauseAlertHours: true, botPauseEscalateHours: true },
    });
    await conv("escalate", "user", 96);
    await conv("alert", "user", 30);
    await conv("bot-last", "assistant", 96);
    await conv("opted-out", "user", 96, { optedOutAt: new Date(now.getTime() - 200 * HOUR) });
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: saved });
    await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: `pause-watch-${runId}` } } });
  });

  it("выключен (как на проде) — ничего не трогает", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botPauseWatchEnabled: false } });
    expect(await runBotPauseWatchTick(now)).toEqual({ alerted: 0, escalated: 0 });
    expect((await pausedUntilOf("escalate"))?.getTime()).toBe(far.getTime());
  });

  it("включён: снимает паузу только там, где клиент ждёт дольше порога, и не трогает остальное", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { botPauseWatchEnabled: true, botPauseAlertHours: 24, botPauseEscalateHours: 72 },
    });
    const result = await runBotPauseWatchTick(now);
    expect(result).toEqual({ alerted: 1, escalated: 1 });

    expect(await pausedUntilOf("escalate")).toBeNull();
    // 30 ч — только отметка, пауза на месте.
    expect((await pausedUntilOf("alert"))?.getTime()).toBe(far.getTime());
    // Последним писал бот/агент — клиент не ждёт, не трогаем.
    expect((await pausedUntilOf("bot-last"))?.getTime()).toBe(far.getTime());
    // Отписавшийся — не трогаем никогда.
    expect((await pausedUntilOf("opted-out"))?.getTime()).toBe(far.getTime());

    // Повторный тик в тот же час не шлёт отметку второй раз (не чаще раза в сутки).
    expect(await runBotPauseWatchTick(now)).toEqual({ alerted: 0, escalated: 0 });
  });
});
