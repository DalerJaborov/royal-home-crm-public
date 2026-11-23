import { beforeEach, describe, expect, it, vi } from "vitest";

type MonitorRow = { enabled: boolean; activatedAt: Date | null; baselineAt: Date | null; sourceStopped: boolean };
const mocks = vi.hoisted(() => ({
  paused: true,
  log: vi.fn(async () => undefined),
  monitor: null as MonitorRow | null,
  lastAccepted: null as { createdAt: Date } | null,
  recipients: [] as Array<{ agentId: string }>,
  eligible: 0,
  firstObserved: null as { seenAt: Date } | null,
  observedCount: 0,
  calls: [] as unknown[],
}));
// Без базы: сторож читает «последнюю принятую отправку» по всей таблице, а соседние файлы
// пишут в ту же таблицу параллельно — живая база сделала бы тест гонкой.
vi.mock("../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: {
    somonMonitor: { findUnique: async () => mocks.monitor },
    somonDelivery: { findFirst: async (args: unknown) => { mocks.calls.push(args); return mocks.lastAccepted; } },
    somonRecipient: { findMany: async () => mocks.recipients },
    agent: { count: async () => mocks.eligible },
    $disconnect: async () => undefined,
    somonSeenAdvert: {
      findFirst: async (args: unknown) => { mocks.calls.push(args); return mocks.firstObserved; },
      count: async () => mocks.observedCount,
    },
  },
}));
vi.mock("../src/lib/telegramPortalPause.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telegramPortalPause.js")>()),
  isTelegramPortalAlertsPaused: async () => mocks.paused,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log,
}));

import {
  checkSomonOwnerLeadsSilence,
  decideSomonSilenceAlarm,
  SOMON_PAUSE_REMIND_HOURS,
  SOMON_SILENCE_HOURS,
  type SomonSilenceInput,
} from "../src/lib/somonLeads/silenceAlarm.js";

/**
 * Живой случай 03.11–17.11.2026: монитор включён, пауза площадок включена, крон каждую
 * минуту «ок», а агентам две недели не ушло ни одной заявки. Сторож обязан это назвать.
 */
const NOW = new Date("2026-11-17T06:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const base: SomonSilenceInput = {
  enabled: true,
  portalPaused: false,
  sourceStopped: false,
  baselineDone: true,
  eligibleRecipients: 3,
  lastAcceptedAt: hoursAgo(1),
  activatedAt: hoursAgo(24 * 20),
  firstObservedAt: hoursAgo(1),
  observedCount: 5,
};

describe("decideSomonSilenceAlarm", () => {
  it("молчит, пока заявки уходят", () => {
    expect(decideSomonSilenceAlarm(base, NOW)).toBeNull();
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: hoursAgo(SOMON_SILENCE_HOURS - 1) }, NOW)).toBeNull();
  });

  it("выключенный монитор — решение владельца, тревоги нет", () => {
    expect(decideSomonSilenceAlarm({ ...base, enabled: false, lastAcceptedAt: hoursAgo(24 * 14) }, NOW)).toBeNull();
  });

  it("пауза площадок: напоминание только после длинного порога", () => {
    expect(decideSomonSilenceAlarm({ ...base, portalPaused: true, lastAcceptedAt: hoursAgo(SOMON_PAUSE_REMIND_HOURS - 1) }, NOW)).toBeNull();
    const alarm = decideSomonSilenceAlarm({ ...base, portalPaused: true, lastAcceptedAt: hoursAgo(24 * 14) }, NOW);
    expect(alarm?.dedupKey).toBe("somon-owner-leads-silent-paused");
    expect(alarm?.message).toContain("пауза");
    expect(alarm?.message).toContain("336 ч");
  });

  it("без паузы сутки тишины с видимой причиной — тревога с названной причиной", () => {
    const cases: Array<[Partial<SomonSilenceInput>, string]> = [
      [{ sourceStopped: true }, "источник Somon остановлен"],
      [{ eligibleRecipients: 0 }, "нет получателей"],
      [{ baselineDone: false }, "разметка"],
    ];
    for (const [patch, text] of cases) {
      const alarm = decideSomonSilenceAlarm({ ...base, ...patch, lastAcceptedAt: hoursAgo(SOMON_SILENCE_HOURS + 1), firstObservedAt: null }, NOW);
      expect(alarm?.dedupKey).toBe("somon-owner-leads-silent");
      expect(alarm?.message).toContain(text);
    }
  });

  it("монитор видит объявления сутки, а агентам ничего — тревога про отбор", () => {
    const alarm = decideSomonSilenceAlarm({ ...base, lastAcceptedAt: hoursAgo(48), firstObservedAt: hoursAgo(SOMON_SILENCE_HOURS + 1), observedCount: 120 }, NOW);
    expect(alarm?.dedupKey).toBe("somon-owner-leads-silent");
    expect(alarm?.message).toContain("120");
  });

  it("сразу после снятия паузы старая отметка 03.11 не даёт ложной тревоги", () => {
    // Последняя отправка две недели назад, пауза только что снята: монитор ещё не видел новых
    // объявлений или видит их меньше суток — молчим.
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: hoursAgo(24 * 14), firstObservedAt: null, observedCount: 0 }, NOW)).toBeNull();
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: hoursAgo(24 * 14), firstObservedAt: hoursAgo(1), observedCount: 30 }, NOW)).toBeNull();
  });

  it("до первой отправки тишина считается от включения монитора", () => {
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: null, activatedAt: hoursAgo(2) }, NOW)).toBeNull();
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: null, activatedAt: hoursAgo(SOMON_SILENCE_HOURS + 2), firstObservedAt: hoursAgo(SOMON_SILENCE_HOURS + 1) }, NOW)?.dedupKey).toBe("somon-owner-leads-silent");
    expect(decideSomonSilenceAlarm({ ...base, lastAcceptedAt: null, activatedAt: null }, NOW)).toBeNull();
  });
});

describe("checkSomonOwnerLeadsSilence — чтение состояния", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.paused = true;
    mocks.monitor = { enabled: true, activatedAt: hoursAgo(24 * 21), baselineAt: hoursAgo(24 * 21), sourceStopped: false };
    mocks.lastAccepted = { createdAt: hoursAgo(24 * 14) };
    mocks.recipients = [{ agentId: "a1" }, { agentId: "a2" }];
    mocks.eligible = 2;
    mocks.firstObserved = null;
    mocks.observedCount = 0;
    mocks.calls.length = 0;
  });

  it("включён + пауза + две недели без отправок → одна запись в журнал ошибок, окно сутки", async () => {
    const alarm = await checkSomonOwnerLeadsSilence(NOW);
    expect(alarm?.dedupKey).toBe("somon-owner-leads-silent-paused");
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith("cron", expect.stringContaining("пауза"), expect.objectContaining({ dedupKey: "somon-owner-leads-silent-paused", dedupWindowMs: 24 * 60 * 60 * 1000 }));
    // Тишина считается по ПРИНЯТЫМ отправкам, самой свежей.
    expect(mocks.calls).toContainEqual({ where: { status: "ACCEPTED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  });

  it("свежая принятая отправка → тишины нет", async () => {
    mocks.paused = false;
    mocks.lastAccepted = { createdAt: hoursAgo(2) };
    expect(await checkSomonOwnerLeadsSilence(NOW)).toBeNull();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("новые объявления считаются только после последней отправки и без разметки", async () => {
    mocks.paused = false;
    mocks.lastAccepted = { createdAt: hoursAgo(48) };
    mocks.firstObserved = { seenAt: hoursAgo(30) };
    mocks.observedCount = 90;
    const alarm = await checkSomonOwnerLeadsSilence(NOW);
    expect(alarm?.message).toContain("90");
    expect(mocks.calls).toContainEqual({ where: { baseline: false, seenAt: { gt: hoursAgo(48) } }, orderBy: { seenAt: "asc" }, select: { seenAt: true } });
  });

  it("получатели есть, но без Telegram → причина названа", async () => {
    mocks.paused = false;
    mocks.lastAccepted = { createdAt: hoursAgo(30) };
    mocks.eligible = 0;
    expect((await checkSomonOwnerLeadsSilence(NOW))?.message).toContain("нет получателей");
  });

  it("монитор выключен или строки нет → ничего не пишет", async () => {
    mocks.monitor = { ...mocks.monitor!, enabled: false };
    expect(await checkSomonOwnerLeadsSilence(NOW)).toBeNull();
    mocks.monitor = null;
    expect(await checkSomonOwnerLeadsSilence(NOW)).toBeNull();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
