import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ refreshAccessToken: vi.fn(async () => null) }));
vi.mock("./deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

const { AssistantStreamError, ASSISTANT_TIMEOUT_MS, streamAssistant, windowMessages } = await import("./assistantStream");
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
