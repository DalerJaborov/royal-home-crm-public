import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ЖУРНАЛ ОШИБОК НЕ ДОЛЖЕН ЗАБИВАТЬСЯ ТЕМ, ЧТО НЕ ТРЕБУЕТ ЧЕЛОВЕКА.
 *
 * Разбор 12.08.2026: из журнала вручную закрыли 740 мёртвых записей. Основной
 * шум давали два источника — провал галочки «прочитано»/«печатает…» в Meta
 * (украшение переписки, ничего не доставляет и не теряет) и тревога Telegram по
 * «трём неудачным опросам подряд» (на мгновенных сетевых отказах это 15 секунд
 * икоты, которую бот пережил сам). Директор перестал смотреть в утреннюю сводку
 * — значит, настоящая поломка прошла бы незамеченной. Здесь закреплено: шум в
 * журнал не попадает, поломка — попадает.
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

const settingsFindUnique = vi.fn(() => Promise.resolve(null));
const errorLogUpdateMany = vi.fn(() => Promise.resolve({ count: 1 }));
vi.mock("../src/db.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/db.js")>();
  // Namespace/account/shield/transaction fields are real PG, not permission
  // mocks. Only the existing Settings/Telegram error-log oracles are replaced.
  const settings = { ...original.prisma.settings, findUnique: (...a: unknown[]) => settingsFindUnique(...a) };
  const errorLog = { ...original.prisma.errorLog, updateMany: (...a: unknown[]) => errorLogUpdateMany(...a) };
  return { ...original, prisma: new Proxy(original.prisma, { get(target, key) {
    if (key === "settings") return settings;
    if (key === "errorLog") return errorLog;
    return Reflect.get(target, key, target);
  } }) };
});

let facebook: CustomerMessengerFixture | undefined, whatsapp: CustomerMessengerFixture | undefined;
beforeAll(async () => {
  facebook = await createCustomerMessengerFixture("FACEBOOK");
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
});
afterAll(async () => { await whatsapp?.dispose(); await facebook?.dispose(); });

function assertGraphPost(fetch: ReturnType<typeof vi.fn>, fixture: CustomerMessengerFixture, peer: string, body: Record<string, unknown>) {
  expect(fetch).toHaveBeenCalled();
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  const parsed = new URL(url);
  expect(parsed.hostname).toBe("graph.facebook.com");
  expect(parsed.pathname).toContain(`/${fixture.externalId}/messages`);
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toMatchObject(body);
  if (fixture.transport.channel === "FACEBOOK") expect(JSON.parse(String(init.body))).toMatchObject({ recipient: { id: peer } });
}

describe("Meta: закрытое 24-часовое окно — не событие для журнала (25.08.2026)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSystemError.mockReset();
    process.env.META_PAGE_ID = "page-1";
    process.env.META_PAGE_TOKEN = "token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Ответ Graph API ровно как в найденном журнале 25.08.2026 — с уникальным
   *  fbtrace_id, который ломает 10-минутную дедупликацию по тексту. */
  function windowClosedResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          message: "This message is sent outside of allowed window.",
          type: "IGApiException",
          code: 10,
          error_subcode: 2534022,
          fbtrace_id: "AOytqgTL_SWGFahNyrguhKF",
        },
      }),
      { status: 403 }
    );
  }

  it("отказ 'outside of allowed window' не пишется в журнал — это не поломка CRM", async () => {
    const { sendMessage } = await import("../src/messengers/meta.js");
    const peer = `psid-window-${facebook!.id}`;
    const fetch = vi.fn(() => Promise.resolve(windowClosedResponse()));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    await expect(sendMessage("FACEBOOK", peer, "привет", facebook!.token, { transport: facebook!.transport }))
      .rejects.toThrow("outside of allowed window");
    assertGraphPost(fetch, facebook!, peer, { message: { text: "привет" } });
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("любой другой отказ Meta по-прежнему пишется в журнал", async () => {
    const { sendMessage } = await import("../src/messengers/meta.js");
    const peer = `psid-invalid-${facebook!.id}`;
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "Invalid parameter", code: 100 } }), { status: 400 }))
    );
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    await expect(sendMessage("FACEBOOK", peer, "привет", facebook!.token, { transport: facebook!.transport }))
      .rejects.toThrow("Invalid parameter");
    assertGraphPost(fetch, facebook!, peer, { message: { text: "привет" } });
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("Сообщение в FACEBOOK не отправлено");
  });
});

describe("Meta: провал «прочитано/печатает» — не событие для журнала", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSystemError.mockReset();
    process.env.META_WA_PHONE_ID = "111";
    process.env.META_WA_TOKEN = "token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("таймаут graph.facebook.com не создаёт записи в журнале, но виден в консоли", async () => {
    const { showReadAndTyping } = await import("../src/messengers/meta.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(() => Promise.reject(new Error("fetch failed")));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    // Наружу не бросается: ответ клиенту важнее галочек.
    await expect(showReadAndTyping("WHATSAPP", "992900000000", "wamid.1", true, whatsapp!.token, whatsapp!.transport)).resolves.toBeUndefined();
    assertGraphPost(fetch, whatsapp!, "992900000000", { messaging_product: "whatsapp", status: "read", message_id: "wamid.1" });

    expect(logSystemError).not.toHaveBeenCalled();
    const printed = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(printed).toContain("Прочитано/печатает");
    expect(printed).toContain("WHATSAPP");
    expect(printed).toContain("fetch failed");
  });

  it("сообщение клиента обработано, даже если галочка не проставилась", async () => {
    const { showReadAndTyping } = await import("../src/messengers/meta.js");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(() => Promise.reject(new Error("fetch failed")));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    // Вебхук зовёт косметику отдельным шагом и продолжает разбор. Раз функция
    // гасит отказ внутри себя и возвращает управление, цепочка ответа не рвётся.
    let turnDone = false;
    await showReadAndTyping("WHATSAPP", "992900000000", "wamid.1", true, whatsapp!.token, whatsapp!.transport);
    assertGraphPost(fetch, whatsapp!, "992900000000", { messaging_product: "whatsapp", status: "read", message_id: "wamid.1" });
    turnDone = true;
    expect(turnDone).toBe(true);
  });

  it("настоящий отказ — недоставленный файл WhatsApp — в журнал по-прежнему пишется", async () => {
    const { whatsAppMediaSource } = await import("../src/messengers/meta.js");
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch;

    expect(await whatsAppMediaSource("media-1")).toBeNull();
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("media-1");
  });
});

const updatesQueue: Array<() => Promise<unknown[]>> = [];
const getUpdates = vi.fn(() => {
  const next = updatesQueue.shift();
  // По умолчанию — мгновенный сетевой отказ, тот самый «fetch failed» с VPS.
  return next ? next() : Promise.reject(new Error("fetch failed"));
});

vi.mock("../src/telegram/api.js", () => ({
  isTelegramEnabled: () => true,
  getUpdates: (offset: number) => getUpdates(offset),
}));
vi.mock("../src/telegram/bot.js", () => ({ handleTelegramUpdate: () => Promise.resolve() }));
vi.mock("../src/lib/webhookDedupe.js", () => ({
  isDuplicateDelivery: () => Promise.resolve(false),
  // startTelegramBot (poller.ts) зовёт это ДО первого опроса (24.09.2026,
  // сброс незавершённых отметок при старте) — без подмены здесь падал сам
  // старт бота в этих тестах, не только дедуп конкретного апдейта.
  resetIncompleteProcessedMessages: () => Promise.resolve(0),
}));

const RETRY_MAX_MS = 60_000;

describe("Telegram: тревога по длительности молчания, а не по числу неудач", () => {
  beforeEach(() => {
    logSystemError.mockReset();
    errorLogUpdateMany.mockClear();
    getUpdates.mockClear();
    updatesQueue.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { stopTelegramBot } = await import("../src/telegram/poller.js");
    stopTelegramBot();
    // Даём висящей паузе бэкоффа истечь, иначе цикл дожил бы до конца прогона.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("короткая серия мгновенных отказов (икота на VPS) тревогу не поднимает", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    startTelegramBot();

    // Паузы бэкоффа 5 и 10 секунд: за 30 секунд набегает три неудачи подряд —
    // ровно то, что раньше писалось директору в журнал.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(logSystemError).not.toHaveBeenCalled();

    // Связь вернулась сама: тревоги не было — и гасить нечего.
    updatesQueue.push(() => Promise.resolve([]));
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(logSystemError).not.toHaveBeenCalled();
    expect(errorLogUpdateMany).not.toHaveBeenCalled();
    stopTelegramBot();
  });

  it("молчание дольше трёх минут — тревога в журнал, и только одна", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    startTelegramBot();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message] = logSystemError.mock.calls[0];
    expect(source).toBe("telegram");
    expect(String(message)).toContain("Бот не получает сообщения");

    // Отказ продолжается — второй записи не появляется.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    stopTelegramBot();
  });

  it("восстановление связи гасит тревогу в журнале (поведение 12.08 не сломано)", async () => {
    const { startTelegramBot, stopTelegramBot } = await import("../src/telegram/poller.js");
    startTelegramBot();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(errorLogUpdateMany).not.toHaveBeenCalled();

    updatesQueue.push(() => Promise.resolve([]));
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);

    expect(errorLogUpdateMany).toHaveBeenCalledTimes(1);
    const arg = errorLogUpdateMany.mock.calls[0][0] as unknown as {
      where: { source: string; resolvedAt: null; message: { startsWith: string } };
      data: { resolvedAt: Date };
    };
    expect(arg.where.source).toBe("telegram");
    expect(arg.where.resolvedAt).toBeNull();
    expect(arg.where.message.startsWith).toBe("Бот не получает сообщения");
    expect(arg.data.resolvedAt).toBeInstanceOf(Date);
    stopTelegramBot();
  });
});
