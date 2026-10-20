import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Честная тревога о потере связи со станцией (ariEvents.ts, createAriAlarm).
 *
 * Логирование обрыва подписки завели 12.08.2026 осознанно: до него телефония
 * могла лежать сутками молча, и агентство теряло входящие. Но писалось оно на
 * КАЖДЫЙ обрыв, а обрыв лечится переподпиской через две секунды — и гашения при
 * восстановлении не было вовсе. Журнал ошибок копил мёртвые записи, утренняя
 * сводка будила директора обрывами, которых давно нет.
 *
 * Правило теперь то же, что у Telegram-поллера: в журнал — только устойчивая
 * потеря связи (дольше трёх минут), одной записью, и она гаснет сама, когда
 * подписка открывается заново.
 */

vi.mock("../src/lib/telephony/ariClient.js", () => ({
  loadAriCredentials: vi.fn(),
  // Досинхронизация после переподписки (resyncActiveChannels) спрашивает у станции
  // живые каналы. Здесь она не должна ни ходить в сеть, ни ронять импорт модуля.
  listActiveChannels: vi.fn().mockResolvedValue([]),
  readChannelVariable: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/db.js", () => ({
  prisma: { errorLog: { updateMany: vi.fn() }, $disconnect: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../src/lib/telephony/callTracker.js", () => ({
  finishCall: vi.fn(),
  getCall: vi.fn(() => undefined),
  setCallState: vi.fn(),
  talkSeconds: vi.fn(() => 0),
}));
vi.mock("../src/lib/telephony/callRecordings.js", () => ({
  forgetRecordingPath: vi.fn(),
  ingestCallRecording: vi.fn(),
  rememberRecordingPath: vi.fn(),
}));
vi.mock("../src/lib/telephony/incomingCalls.js", () => ({
  classifyInboundChannel: vi.fn(() => ({ inbound: false, reason: "context" })),
  finishIncomingCall: vi.fn(),
  isInboundChannel: vi.fn(() => false),
  isTrackedIncoming: vi.fn(() => false),
  markIncomingBridged: vi.fn(),
  noteRejectedInbound: vi.fn(),
  refreshInboundContexts: vi.fn().mockResolvedValue(undefined),
  startIncomingCall: vi.fn(),
}));

const { logSystemError } = await import("../src/lib/systemError.js");
const { prisma } = await import("../src/db.js");
const { createAriAlarm, startPingWatchdog } = await import("../src/lib/telephony/ariEvents.js");

const updateMany = vi.mocked(prisma.errorLog.updateMany);

describe("createAriAlarm: в журнал попадает только устойчивая потеря связи", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logSystemError).mockClear();
    // Именно mockReset + переустановка ответа: restoreAllMocks в afterEach
    // снимает реализацию, заданную в фабрике мока модуля.
    updateMany.mockReset();
    updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("короткий обрыв с успешным переподключением не оставляет записи в журнале", async () => {
    const alarm = createAriAlarm();

    alarm.lost("подписка закрыта (код 1006)");
    await vi.advanceTimersByTimeAsync(2_000);
    alarm.connected();

    expect(logSystemError).not.toHaveBeenCalled();
    // Гасить нечего — лишнего запроса к базе тоже быть не должно.
    expect(updateMany).not.toHaveBeenCalled();
    // Но в консоли контейнера обрыв обязан остаться: разбирать сетевые проблемы
    // по-прежнему есть по чему.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("связи со станцией нет"));
  });

  it("связь держалась три часа, потом обрыв на две секунды — тревоги нет (E5, 02.10.2026)", async () => {
    const alarm = createAriAlarm();
    alarm.connected();
    // Раньше тишина считалась от открытия подписки: первый же lost() после трёх
    // часов работы видел «10800 с без связи» и будил директоров пушем.
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    alarm.lost("подписка закрыта (код 1006)");
    await vi.advanceTimersByTimeAsync(2_000);
    alarm.lost("connect ECONNREFUSED");
    alarm.connected();

    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("флапающий туннель: десять обрывов подряд за минуту — по-прежнему ни одной записи", async () => {
    const alarm = createAriAlarm();

    for (let i = 0; i < 10; i += 1) {
      alarm.lost("connect ECONNREFUSED");
      await vi.advanceTimersByTimeAsync(6_000);
      alarm.connected();
    }

    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("связи нет дольше порога — ровно одна запись, сколько бы обрывов ни повторилось", async () => {
    const alarm = createAriAlarm();

    // Станция недоступна: каждая попытка даёт error и следом close.
    alarm.lost("connect ECONNREFUSED");
    alarm.lost("подписка закрыта (код 1006)");
    expect(logSystemError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    alarm.lost("connect ECONNREFUSED");

    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(logSystemError).toHaveBeenCalledWith(
      "telephony",
      expect.stringContaining("Нет связи с событиями АТС"),
      // dedupKey стабильный (без переменного числа секунд простоя) — иначе
      // счётчик секунд в начале текста давал бы каждому обрыву свой ключ
      // дедупликации, и один и тот же отказ уходил бы в журнал многократно
      // (найдено на проде 15.09.2026).
      { dedupKey: "Нет связи с событиями АТС" }
    );

    // Отказ длится дальше — журнал не растёт.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    alarm.lost("подписка закрыта (код 1006)");
    alarm.lost("connect ECONNREFUSED");
    expect(logSystemError).toHaveBeenCalledTimes(1);
  });

  it("восстановление после тревоги гасит её — resolvedAt проставлен у своей записи", async () => {
    const alarm = createAriAlarm();

    alarm.lost("connect ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.lost("connect ECONNREFUSED");
    expect(logSystemError).toHaveBeenCalledTimes(1);

    alarm.connected();

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0] as {
      where: { source: string; resolvedAt: null; message: { startsWith: string } };
      data: { resolvedAt: Date };
    };
    expect(call.where.source).toBe("telephony");
    expect(call.where.resolvedAt).toBeNull();
    // Текст тревоги начинается ровно с того, по чему она ищется при гашении.
    const alarmText = vi.mocked(logSystemError).mock.calls[0][1];
    expect(alarmText.startsWith(call.where.message.startsWith)).toBe(true);
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
  });

  it("после гашения следующая устойчивая потеря снова поднимает тревогу", async () => {
    const alarm = createAriAlarm();

    alarm.lost("первый отказ");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.lost("первый отказ");
    alarm.connected();
    expect(logSystemError).toHaveBeenCalledTimes(1);

    alarm.lost("второй отказ");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.lost("второй отказ");
    expect(logSystemError).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logSystemError).mock.calls[1][1]).toContain("второй отказ");
  });

  it("падение базы при гашении не роняет подписку", async () => {
    const alarm = createAriAlarm();
    updateMany.mockRejectedValueOnce(new Error("Postgres недоступен"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    alarm.lost("connect ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    alarm.lost("connect ECONNREFUSED");
    expect(() => alarm.connected()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(console.error).toHaveBeenCalledWith("[телефония] тревога не снята:", "Postgres недоступен");
  });
});

describe("startPingWatchdog: отсутствие pong больше не пишет собственную запись", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logSystemError).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("сторож рвёт соединение и молчит в журнале — решение принимает createAriAlarm", async () => {
    const watchdog = startPingWatchdog({ ping: vi.fn(), terminate: vi.fn() }, 30_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(logSystemError).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("нет pong от АТС"));
    watchdog.stop();
  });
});
