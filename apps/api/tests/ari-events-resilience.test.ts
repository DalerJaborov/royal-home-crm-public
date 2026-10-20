import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Живучесть подписки на события АТС (ariEvents.ts).
 *
 * Два дефекта, найденные аудитом 12.08.2026 при разборе прод-факта «IncomingCall
 * пуст при 21 реальном входящем за неделю»:
 *
 *  1. connect() бросал ДО навешивания обработчиков close/error (loadAriCredentials,
 *     new URL, new WebSocket) — вызывается как `void connect()`, реджект терялся,
 *     переподписка не планировалась НИКОГДА. Секундная просадка Postgres в момент
 *     реконнекта убивала телефонию до рестарта процесса.
 *  2. Полуоткрытый TCP через обратный SSH-туннель не даёт ни close, ни error —
 *     события молча перестают приходить, а CRM считает подписку живой.
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
vi.mock("../src/lib/telephony/callTracker.js", () => ({
  finishCall: vi.fn(),
  getCall: vi.fn(() => undefined),
  reconcileOrphanedOutgoingCalls: vi.fn().mockResolvedValue(0),
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

const { loadAriCredentials } = await import("../src/lib/telephony/ariClient.js");
const { logSystemError } = await import("../src/lib/systemError.js");

describe("ariEvents: connect() не умирает молча", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(loadAriCredentials).mockReset();
    vi.mocked(logSystemError).mockClear();
  });

  afterEach(async () => {
    const { stopAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    stopAriEvents();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("бросок в loadAriCredentials не убивает подписку навсегда — переподписка планируется", async () => {
    vi.mocked(loadAriCredentials).mockRejectedValue(new Error("Postgres недоступен"));
    const { startAriEvents } = await import("../src/lib/telephony/ariEvents.js");

    startAriEvents();
    // Дать промисе connect() дойти до catch.
    await vi.advanceTimersByTimeAsync(0);

    expect(logSystemError).toHaveBeenCalledWith(
      "telephony",
      expect.stringContaining("Подписка на события АТС не открылась"),
      // С 02.10.2026 (E11) — с постоянным ключом вида поломки.
      expect.objectContaining({ dedupKey: expect.any(String) })
    );

    // Без починки следующая попытка не планируется никогда — reconnectDelay
    // остаётся неиспробованным.
    //
    // ЖДЁМ 0 МС, А НЕ 2000 (18.08.2026). Тест раньше закреплял RECONNECT_MIN_MS = 2с,
    // и это ровно то поведение, из-за которого терялись звонки: подписка рвётся
    // 30–46 раз в сутки, и каждые лишние две секунды слепоты — это входящий без
    // карточки и без перевода на агента. Первая попытка теперь идёт немедленно.
    vi.mocked(loadAriCredentials).mockResolvedValue({
      url: "http://pbx.local:8088",
      username: "u",
      password: "p",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(loadAriCredentials).toHaveBeenCalledTimes(2);
  });

  it("бросок при кривом URL в Настройках тоже планирует переподписку", async () => {
    vi.mocked(loadAriCredentials).mockResolvedValue({ url: "не url вовсе", username: "u", password: "p" });
    const { startAriEvents } = await import("../src/lib/telephony/ariEvents.js");

    startAriEvents();
    await vi.advanceTimersByTimeAsync(0);

    expect(logSystemError).toHaveBeenCalledWith(
      "telephony",
      expect.stringContaining("Подписка на события АТС не открылась"),
      // С 02.10.2026 (E11) — с постоянным ключом вида поломки.
      expect.objectContaining({ dedupKey: expect.any(String) })
    );

    // Первые попытки уже отработали выше (первая идёт без ожидания вовсе), поэтому
    // лестница задержек тут в неизвестной точке — ждём её потолок. Тест стережёт сам
    // факт «переподписка планируется», а её скорость закреплена отдельным тестом ниже.
    vi.mocked(loadAriCredentials).mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadAriCredentials).toHaveBeenCalled();
  });

  it("stopAriEvents отменяет запланированную переподписку — воскресший таймер не поднимает connect() заново", async () => {
    vi.mocked(loadAriCredentials).mockRejectedValue(new Error("сеть моргнула"));
    const { startAriEvents, stopAriEvents } = await import("../src/lib/telephony/ariEvents.js");

    startAriEvents();
    await vi.advanceTimersByTimeAsync(0);
    stopAriEvents();

    vi.mocked(loadAriCredentials).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadAriCredentials).not.toHaveBeenCalled();
  });
});

describe("startPingWatchdog: полуоткрытый сокет обнаруживается и убивается", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("нет pong на предыдущий ping — terminate(), а не close()", async () => {
    const { startPingWatchdog } = await import("../src/lib/telephony/ariEvents.js");
    const ping = vi.fn();
    const terminate = vi.fn();
    const watchdog = startPingWatchdog({ ping, terminate }, 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();

    // Pong не пришёл — второй тик обязан разорвать соединение.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminate).toHaveBeenCalledTimes(1);

    watchdog.stop();
  });

  it("markAlive() (pong или любое сообщение) откладывает terminate", async () => {
    const { startPingWatchdog } = await import("../src/lib/telephony/ariEvents.js");
    const ping = vi.fn();
    const terminate = vi.fn();
    const watchdog = startPingWatchdog({ ping, terminate }, 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    watchdog.markAlive(); // pong пришёл вовремя
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminate).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledTimes(2);

    watchdog.stop();
  });

  it("stop() останавливает дальнейшие проверки", async () => {
    const { startPingWatchdog } = await import("../src/lib/telephony/ariEvents.js");
    const ping = vi.fn();
    const terminate = vi.fn();
    const watchdog = startPingWatchdog({ ping, terminate }, 30_000);
    watchdog.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(ping).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });
});

/**
 * ГЛАВНОЕ ТРЕБОВАНИЕ ВЛАДЕЛЬЦА: «чтобы ни один звонок не был никогда потерян».
 *
 * Аудит станционного лога 18.08.2026: подписка на события ARI рвалась 30–46 раз в
 * сутки, каждый раз на 4–15 секунд, и всё это время Asterisk писал «Inactive Stasis
 * app 'royal-home-crm' missed message». События ARI нигде не буферизуются: звонок,
 * начавшийся в разрыв, для CRM не существовал вовсе.
 *
 * Закрыто тремя вещами, и каждая проверяется ниже:
 *  1) мгновенная первая переподписка вместо двух секунд (тесты выше);
 *  2) невозможность открыть ДВА параллельных сокета при гонке close/error/таймера;
 *  3) досинхронизация: после переподписки спрашиваем станцию, что у неё в эфире.
 */
describe("переподписка не плодит параллельные соединения", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(loadAriCredentials).mockReset();
    vi.mocked(logSystemError).mockClear();
  });

  afterEach(async () => {
    const { stopAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    stopAriEvents();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("второй вход в connect(), пока первый ждёт креды из базы, не открывает второй сокет", async () => {
    // Между входом в connect() и присвоением socket стоит await похода в Postgres.
    // Задерживаем именно его — это и есть то окно, в котором раньше проскакивал
    // второй вызов, и станция получала два сокета: каждое событие обрабатывалось
    // дважды (две карточки на входящий, две выгрузки записи, два разбора у Gemini).
    let release: (() => void) | undefined;
    vi.mocked(loadAriCredentials).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ url: "http://pbx.local:8088", username: "u", password: "p" });
        })
    );

    const { startAriEvents } = await import("../src/lib/telephony/ariEvents.js");
    startAriEvents();
    startAriEvents(); // гонка: второй путь к connect(), пока первый ещё в await
    await vi.advanceTimersByTimeAsync(0);

    expect(loadAriCredentials).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("лестница задержек упирается в секунды, а не в минуту", async () => {
    vi.mocked(loadAriCredentials).mockRejectedValue(new Error("станция лежит"));
    const { startAriEvents } = await import("../src/lib/telephony/ariEvents.js");

    startAriEvents();
    // Разгоняем лестницу заведомо больше, чем нужно для выхода на потолок.
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(5_000);

    vi.mocked(loadAriCredentials).mockClear();
    // Прежний потолок — 60 секунд: за 5 секунд не случилось бы ни одной попытки.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadAriCredentials).toHaveBeenCalled();
  });
});

describe("resyncActiveChannels: звонок, начавшийся в разрыв связи, не пропадает", () => {
  const creds = { url: "http://pbx.local:8088", username: "u", password: "p" };

  const channel = (id: string, number: string) => ({
    id,
    name: `SIP/trunk-${id}`,
    state: "Ring",
    caller: { number },
    dialplan: { context: "from-trunk" },
  });

  beforeEach(async () => {
    vi.mocked(logSystemError).mockClear();
    const ari = await import("../src/lib/telephony/ariClient.js");
    vi.mocked(ari.listActiveChannels).mockReset().mockResolvedValue([]);
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(incoming.startIncomingCall).mockReset().mockResolvedValue(undefined);
    vi.mocked(incoming.isTrackedIncoming).mockReset().mockReturnValue(false);
    vi.mocked(incoming.classifyInboundChannel).mockReset().mockReturnValue({ inbound: true });
  });

  afterEach(() => vi.resetModules());

  it("неизвестный входящий канал подхватывается тем же путём, что и живое событие", async () => {
    const ari = await import("../src/lib/telephony/ariClient.js");
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(ari.listActiveChannels).mockResolvedValue([channel("c1", "992930001001")]);

    const { resyncActiveChannels } = await import("../src/lib/telephony/ariEvents.js");
    await resyncActiveChannels(creds);

    expect(incoming.startIncomingCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incoming.startIncomingCall).mock.calls[0][0].id).toBe("c1");
  });

  it("уже известный звонок не заводится повторно — досинхронизация идемпотентна", async () => {
    const ari = await import("../src/lib/telephony/ariClient.js");
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(ari.listActiveChannels).mockResolvedValue([channel("c1", "992930001001")]);
    vi.mocked(incoming.isTrackedIncoming).mockReturnValue(true);

    const { resyncActiveChannels } = await import("../src/lib/telephony/ariEvents.js");
    await resyncActiveChannels(creds);

    expect(incoming.startIncomingCall).not.toHaveBeenCalled();
  });

  it("не входящий канал (свой исходящий, Local очереди, короткий номер) пропускается", async () => {
    const ari = await import("../src/lib/telephony/ariClient.js");
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(ari.listActiveChannels).mockResolvedValue([channel("c2", "1001")]);
    vi.mocked(incoming.classifyInboundChannel).mockReturnValue({ inbound: false, reason: "short-number" });

    const { resyncActiveChannels } = await import("../src/lib/telephony/ariEvents.js");
    await resyncActiveChannels(creds);

    expect(incoming.startIncomingCall).not.toHaveBeenCalled();
  });

  it("сорвавшийся подхват одного звонка не уносит с собой остальные", async () => {
    const ari = await import("../src/lib/telephony/ariClient.js");
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(ari.listActiveChannels).mockResolvedValue([
      channel("c1", "992930001001"),
      channel("c2", "992930001002"),
    ]);
    vi.mocked(incoming.startIncomingCall)
      .mockRejectedValueOnce(new Error("Postgres моргнул"))
      .mockResolvedValue(undefined);

    const { resyncActiveChannels } = await import("../src/lib/telephony/ariEvents.js");
    await resyncActiveChannels(creds);

    expect(incoming.startIncomingCall).toHaveBeenCalledTimes(2);
    expect(logSystemError).toHaveBeenCalledWith("telephony", expect.stringContaining("не подхвачен"), expect.objectContaining({ dedupKey: expect.any(String) }));
  });

  it("отказ станции пишется в журнал ОДИН раз, а не на каждый обрыв", async () => {
    const ari = await import("../src/lib/telephony/ariClient.js");
    vi.mocked(ari.listActiveChannels).mockRejectedValue(new Error("timeout"));

    const { resyncActiveChannels } = await import("../src/lib/telephony/ariEvents.js");
    for (let i = 0; i < 5; i += 1) await resyncActiveChannels(creds);

    const complaints = vi
      .mocked(logSystemError)
      .mock.calls.filter(([, message]) => String(message).includes("Живые каналы у станции не спрошены"));
    expect(complaints).toHaveLength(1);
  });
});

/**
 * Входящий, который взял консультант на телефоне (24.09.2026, робозвонок): канал
 * уходит в Stasis-приложение живого голоса, и StasisEnd приходит, когда консультант
 * соединяет человека с агентом, — звонок при этом продолжается. Закрыть его по
 * StasisEnd значило бы потерять разговор с агентом.
 */
describe("ariEvents: конец входящего — только когда канал уничтожен", () => {
  beforeEach(async () => {
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    vi.mocked(incoming.isTrackedIncoming).mockReset().mockReturnValue(true);
    vi.mocked(incoming.finishIncomingCall).mockReset().mockResolvedValue(null);
  });

  afterEach(() => vi.resetModules());

  it("StasisEnd у входящего звонок не закрывает, ChannelDestroyed — закрывает", async () => {
    const incoming = await import("../src/lib/telephony/incomingCalls.js");
    const { handleAriEvent } = await import("../src/lib/telephony/ariEvents.js");
    const channel = { id: "in-1", name: "SIP/trunk-1", state: "Up", caller: { number: "992930001001" } };

    await handleAriEvent({ type: "StasisEnd", channel } as never);
    expect(incoming.finishIncomingCall).not.toHaveBeenCalled();

    await handleAriEvent({ type: "ChannelDestroyed", channel } as never);
    expect(incoming.finishIncomingCall).toHaveBeenCalledWith("in-1");
  });
});
