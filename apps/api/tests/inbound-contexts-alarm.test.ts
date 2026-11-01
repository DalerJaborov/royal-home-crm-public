import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Чтение списка входящих контекстов и журнал ошибок (incomingCalls.ts).
 *
 * Список перечитывается раз в пять минут. При просадке Postgres запись «Список
 * входящих контекстов не прочитан» уходила в журнал каждым тиком — при том, что
 * просадка базы видна из десятка других мест, а по этой строке человеку делать
 * нечего: CRM остаётся на прежнем списке и входящие принимает.
 *
 * Правило теперь то же, что у тревоги связи с АТС и Telegram-поллера: в журнал —
 * только устойчивая невозможность прочитать настройку (дольше трёх минут), одной
 * записью, и она гаснет сама, когда чтение восстанавливается. Одиночный отказ
 * остаётся в консоли контейнера.
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    errorLog: { updateMany: vi.fn() },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(),
  sendPushToAgents: vi.fn(),
}));
vi.mock("../src/lib/recipients.js", () => ({ findAgentsWithPermission: vi.fn().mockResolvedValue([]) }));

const { logSystemError } = await import("../src/lib/systemError.js");
const { prisma } = await import("../src/db.js");
const { createInboundContextsAlarm, refreshInboundContexts, isInboundContext, setInboundContextsForTest } =
  await import("../src/lib/telephony/incomingCalls.js");

const updateMany = vi.mocked(prisma.errorLog.updateMany);
const findUnique = vi.mocked(prisma.settings.findUnique);

describe("createInboundContextsAlarm: в журнал попадает только устойчивый отказ", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logSystemError).mockClear();
    updateMany.mockReset();
    updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("разовый отказ чтения записи не оставляет — но в консоли он есть", () => {
    const alarm = createInboundContextsAlarm();

    alarm.failed("Can't reach database server");

    expect(logSystemError).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("список входящих контекстов не прочитан"));
  });

  it("отказ и восстановление на следующем тике — журнал молчит", async () => {
    const alarm = createInboundContextsAlarm();

    alarm.failed("Can't reach database server");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    alarm.ok();

    expect(logSystemError).not.toHaveBeenCalled();
    // Гасить нечего — лишнего запроса к базе тоже быть не должно.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("настройка не читается дольше порога — ровно одна запись, сколько бы тиков ни прошло", async () => {
    const alarm = createInboundContextsAlarm();

    alarm.failed("Can't reach database server");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    alarm.failed("Can't reach database server");

    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith(
      "telephony",
      expect.stringContaining("Список входящих контекстов не читается")
    );

    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      alarm.failed("Can't reach database server");
    }
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });

  it("восстановление гасит тревогу — resolvedAt проставлен у своей записи", async () => {
    const alarm = createInboundContextsAlarm();

    alarm.failed("Can't reach database server");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.failed("Can't reach database server");
    expect(logSystemError).toHaveBeenCalledTimes(1);

    alarm.ok();

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0] as {
      where: { source: string; resolvedAt: null; message: { startsWith: string } };
      data: { resolvedAt: Date };
    };
    expect(call.where.source).toBe("telephony");
    expect(call.where.resolvedAt).toBeNull();
    const alarmText = vi.mocked(logSystemError).mock.calls[0][1];
    expect(alarmText.startsWith(call.where.message.startsWith)).toBe(true);
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
  });

  it("после гашения серия начинается заново: одиночный отказ снова молчит", async () => {
    const alarm = createInboundContextsAlarm();

    alarm.failed("первый отказ");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.failed("первый отказ");
    alarm.ok();
    expect(logSystemError).toHaveBeenCalledTimes(1);

    alarm.failed("второй отказ");
    expect(logSystemError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.failed("второй отказ");
    expect(logSystemError).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logSystemError).mock.calls[1][1]).toContain("второй отказ");
  });

  it("падение базы при гашении не роняет телефонию", async () => {
    const alarm = createInboundContextsAlarm();
    updateMany.mockRejectedValueOnce(new Error("Postgres недоступен"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    alarm.failed("Can't reach database server");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.failed("Can't reach database server");
    expect(() => alarm.ok()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(console.error).toHaveBeenCalledWith("[телефония] тревога не снята:", "Postgres недоступен");
  });
});

describe("refreshInboundContexts: список из кода, база не читается (с 01.11.2026)", () => {
  beforeEach(() => {
    vi.mocked(logSystemError).mockClear();
    findUnique.mockReset();
    findUnique.mockRejectedValue(new Error("Can't reach database server"));
  });

  afterEach(() => {
    setInboundContextsForTest(null);
  });

  it("отказ базы не влияет: настройки не читаются, тревоги нет", async () => {
    await refreshInboundContexts();

    expect(findUnique).not.toHaveBeenCalled();
    expect(logSystemError).not.toHaveBeenCalled();
  });
});
