import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("./api", () => ({ refreshAccessToken: vi.fn(async () => null), api: apiMock }));
vi.mock("./deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

const {
  AssistantActionRequestError,
  AssistantStreamError,
  ASSISTANT_TIMEOUT_MS,
  requestAssistantActionCancel,
  requestAssistantActionConfirm,
  isActionView,
  streamAssistant,
  requestAssistantActionUndo,
  windowMessages,
} = await import("./assistantStream");
const { ApiError } = await import("./apiError");
const { loadAssistantHistory, saveAssistantHistory } = await import("./assistantHistory");
const { useAuthStore } = await import("../store/auth");

const sse = (...frames: Array<[string, unknown]>) =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

function streamResponse(body: string, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Режем на два куска посреди кадра — разбор обязан склеить буфер.
      const bytes = encoder.encode(body);
      const half = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, half));
      controller.enqueue(bytes.slice(half));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** fetch, который никогда не отвечает, пока его не оборвут сигналом. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  );
}

const ask = [{ role: "user" as const, content: "ОБ-88" }];

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("windowMessages", () => {
  it("отправляет не больше 12 последних реплик и начинает с реплики человека", () => {
    const history = Array.from({ length: 31 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    const win = windowMessages(history);
    expect(win.length).toBeLessThanOrEqual(12);
    expect(win[0].role).toBe("user");
    expect(win[win.length - 1].content).toBe("m30");
  });

  it("режет реплику длиннее 4000 символов, а не получает 400 от сервера", () => {
    const [m] = windowMessages([{ role: "user", content: "я".repeat(5000) }]);
    expect(m.content).toHaveLength(4000);
  });

  it("без реплики человека в окне отправлять нечего", () => {
    expect(windowMessages([{ role: "assistant", content: "привет" }])).toEqual([]);
  });
});

describe("streamAssistant", () => {
  it("разбирает status, card и done из разрезанного потока", async () => {
    const card = { kind: "property", id: "p1", code: "ОБ-000088", href: "/properties/p1" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(sse(["status", { message: "Ищу…" }], ["card", card], ["card", { kind: "evil", href: "http://x" }], ["done", { reply: "Готово" }])),
      ),
    );
    const onStatus = vi.fn();
    const onCard = vi.fn();
    await expect(streamAssistant(ask, onStatus, { onCard })).resolves.toBe("Готово");
    expect(onStatus).toHaveBeenCalledWith("Ищу…");
    // Чужой вид карточки и внешняя ссылка отбрасываются.
    expect(onCard).toHaveBeenCalledTimes(1);
    expect(onCard).toHaveBeenCalledWith(card);
  });

  it("token: текст копится по мере прихода, reset начинает черновик заново, итог — из done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse(
          sse(
            ["token", { text: "Сейчас " }],
            ["token", { text: "посмотрю" }],
            ["status", { message: "Уточняю данные…" }],
            ["token", { text: "Нашёл ", reset: true }],
            ["token", { text: "двоих." }],
            ["done", { reply: "Нашёл двоих." }],
          ),
        ),
      ),
    );
    const onToken = vi.fn();
    await expect(streamAssistant(ask, () => undefined, { onToken })).resolves.toBe("Нашёл двоих.");
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(["Сейчас ", "Сейчас посмотрю", "Нашёл ", "Нашёл двоих."]);
  });

  it("без событий token (старый сервер, быстрый путь) — текст берётся из done, onToken не зовётся", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(sse(["done", { reply: "Только done" }]))));
    const onToken = vi.fn();
    await expect(streamAssistant(ask, () => undefined, { onToken })).resolves.toBe("Только done");
    expect(onToken).not.toHaveBeenCalled();
  });

  it("токены пришли, а потока done нет — обрыв, а не полуответ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(sse(["token", { text: "Начало" }]))));
    await expect(streamAssistant(ask, () => undefined, { onToken: () => undefined })).rejects.toMatchObject({
      code: "server",
      retryable: true,
    });
  });

  it("зависший сервер: через таймаут — ошибка timeout с повтором, а не вечная «загрузка»", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const err = await streamAssistant(ask, () => undefined, { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(AssistantStreamError);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(ASSISTANT_TIMEOUT_MS).toBe(30_000);
  });

  it("отмена снаружи (закрытие панели): код aborted, без повтора", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const pending = streamAssistant(ask, () => undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", retryable: false });
  });

  it("обрыв сети — понятное сообщение и повтор", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(streamAssistant(ask, () => undefined)).rejects.toMatchObject({ code: "network", retryable: true });
  });

  it("лимит 429 — текст сервера, повторять бессмысленно", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Слишком много запросов" }), { status: 429 })),
    );
    await expect(streamAssistant(ask, () => undefined)).rejects.toMatchObject({
      code: "http",
      message: "Слишком много запросов",
      retryable: false,
    });
  });

  it("событие error из потока — ошибка сервера с повтором", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(sse(["error", { error: "ИИ недоступен" }]))));
    await expect(streamAssistant(ask, () => undefined)).rejects.toMatchObject({
      code: "server",
      message: "ИИ недоступен",
      retryable: true,
    });
  });
});

const actionView = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  tool: "change_client_agent",
  status: "PENDING",
  preview: { title: "Передать клиента", was: { agent: "Иванов" }, becomes: { agent: "Петров" } },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  executedAt: null,
  undoneAt: null,
  undoUntil: null,
  result: null,
  ...over,
});

describe("событие confirm и заголовок X-Assistant-Confirm (П4а)", () => {
  it("с onConfirm — заголовок уходит, карточка действия приходит; кривое событие отбрасывается", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      streamResponse(
        sse(
          ["confirm", actionView()],
          ["confirm", { id: "x", status: "WHATEVER" }],
          ["confirm", actionView({ preview: { title: "<b>", was: "не объект", becomes: {} } })],
          ["done", { reply: "Подтвердите" }],
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onConfirm = vi.fn();
    await expect(streamAssistant(ask, () => undefined, { onConfirm })).resolves.toBe("Подтвердите");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ status: "PENDING", preview: { title: "Передать клиента" } });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Assistant-Confirm"]).toBe("1");
  });

  it("без onConfirm заголовка нет — сервер не объявит модели инструменты записи", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => streamResponse(sse(["done", { reply: "ок" }])));
    vi.stubGlobal("fetch", fetchMock);
    await streamAssistant(ask, () => undefined);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Assistant-Confirm"]).toBeUndefined();
  });

  it("isActionView: статус только из списка, превью с объектами was/becomes", () => {
    expect(isActionView(actionView())).toBe(true);
    expect(isActionView(actionView({ status: "DONE" }))).toBe(false);
    expect(isActionView(actionView({ undoUntil: 5 }))).toBe(false);
    expect(isActionView(actionView({ preview: { title: "x", was: [], becomes: {} } }))).toBe(false);
    expect(isActionView(null)).toBe(false);
  });

  it("isActionView: risk объектом и irreversible строкой — событие отброшено (общая схема)", () => {
    const preview = { title: "x", was: {}, becomes: {} };
    expect(isActionView(actionView({ preview: { ...preview, risk: { a: 1 } } }))).toBe(false);
    expect(isActionView(actionView({ preview: { ...preview, irreversible: "true" } }))).toBe(false);
    expect(isActionView(actionView({ preview: { ...preview, risk: "ок", irreversible: true } }))).toBe(true);
  });
});

describe("подтверждение, отмена и откат действия (П4а)", () => {
  beforeEach(() => apiMock.mockReset());

  it("ходят через общий api() POST по своему пути и отдают исход", async () => {
    apiMock.mockResolvedValue({ action: actionView({ status: "EXECUTED" }), replay: false });
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(requestAssistantActionConfirm(id)).resolves.toMatchObject({ action: { status: "EXECUTED" }, replay: false });
    await requestAssistantActionCancel(id);
    await requestAssistantActionUndo(id);
    expect(apiMock.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
      [`/ai/assistant/actions/${id}/confirm`, "POST"],
      [`/ai/assistant/actions/${id}/cancel`, "POST"],
      [`/ai/assistant/actions/${id}/undo`, "POST"],
    ]);
  });

  it("409 STALE: код и свежее действие наружу", async () => {
    const fresh = actionView({ id: "22222222-2222-4222-8222-222222222222" });
    apiMock.mockRejectedValueOnce(
      new ApiError("Данные изменились", 409, { error: "Данные изменились", code: "STALE", stale: true, action: fresh }),
    );
    const err = await requestAssistantActionConfirm("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantActionRequestError);
    const e = err as InstanceType<typeof AssistantActionRequestError>;
    expect([e.status, e.code, e.action?.id]).toEqual([409, "STALE", fresh.id]);
  });

  it("409 STALE без нового превью, 410, 403 — код и пустое действие", async () => {
    for (const [status, code] of [[409, "STALE"], [410, "EXPIRED"], [403, "FORBIDDEN"]] as const) {
      apiMock.mockRejectedValueOnce(new ApiError("x", status, { error: "x", code, action: null }));
      await expect(requestAssistantActionConfirm("a")).rejects.toMatchObject({ status, code, action: null });
    }
  });

  it("сеть упала — status 0, кривой ответ сервера — тоже ошибка, а не тихий успех", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(requestAssistantActionConfirm("a")).rejects.toMatchObject({ status: 0, code: null });
    apiMock.mockResolvedValueOnce({ ok: true });
    await expect(requestAssistantActionConfirm("a")).rejects.toBeInstanceOf(AssistantActionRequestError);
  });
});

describe("история в sessionStorage", () => {
  function stubStorage(impl: Partial<Storage> & { data?: Map<string, string> }) {
    const data = impl.data ?? new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        ...impl,
      },
    });
    return data;
  }

  beforeEach(() => {
    useAuthStore.setState({ agent: { id: "agent-1" } as never });
  });

  it("сохраняет и возвращает переписку, чужой сотрудник в той же вкладке её не видит", () => {
    stubStorage({});
    saveAssistantHistory([{ role: "user", content: "привет" }]);
    expect(loadAssistantHistory()).toEqual([{ role: "user", content: "привет" }]);
    useAuthStore.setState({ agent: { id: "agent-2" } as never });
    expect(loadAssistantHistory()).toEqual([]);
  });

  it("хранилище бросает — панель живёт с пустой перепиской, а не падает", () => {
    stubStorage({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => saveAssistantHistory([{ role: "user", content: "x" }])).not.toThrow();
    expect(loadAssistantHistory()).toEqual([]);
  });

  it("битый JSON в хранилище не роняет загрузку", () => {
    const data = stubStorage({});
    data.set("rh.assistant.history.v1:agent-1", "{not json");
    expect(loadAssistantHistory()).toEqual([]);
  });
});
