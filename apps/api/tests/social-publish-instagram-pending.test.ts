import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ОТЛОЖЕННЫЙ КОНТЕЙНЕР INSTAGRAM — НЕ ОТКАЗ (случай №111, 21.09.2026, объект
 * №111: публикация упала «Видео не обработалось за отведённое время ожидания»,
 * пока Meta одновременно обрабатывала два объекта плюс историю — сам ролик
 * крошечный, 22.3 с/26.8 МБ, дело было не в весе). Покрывает
 * lib/socialPublish.ts::waitForInstagramContainerReady (лесенка ожидания,
 * ~4 мин 42 с) и rememberInstagramContainer — с 22.09.2026 контейнер
 * запоминается СРАЗУ после создания, ДО окна ожидания (рестарт внутри окна
 * иначе терял уже загруженный ролик молча).
 *
 * БД подменена ЦЕЛИКОМ (не реальный Postgres) — единственный вызов Prisma в
 * этих функциях это pendingInstagramContainer.create, реальная запись и её
 * применение фоновым тиком проверены отдельно
 * (instagram-pending-containers-tick.test.ts). Таймеры — фейковые:
 * CONTAINER_POLL_INTERVALS_MS суммарно ждёт реальные ~4м42с, реальными часами
 * тест был бы недопустимо медленным.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { pendingCreate, pendingUpdateMany } = vi.hoisted(() => ({
  pendingCreate: vi.fn(async () => ({})),
  pendingUpdateMany: vi.fn(async () => ({ count: 1 })),
}));
vi.mock("../src/db.js", () => ({
  prisma: {
    pendingInstagramContainer: { create: pendingCreate, updateMany: pendingUpdateMany },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

/** Чем закрыли запись контейнера: пульс живого хозяина (только lastCheckedAt)
 *  сюда не попадает — он не «закрытие», а отметка «я ещё жду». */
function resolutions(): Array<{ containerId: string; status: string }> {
  return pendingUpdateMany.mock.calls
    .map((c) => c[0] as { where: { containerId: string }; data: { status?: string } })
    .filter((c) => typeof c.data.status === "string")
    .map((c) => ({ containerId: c.where.containerId, status: c.data.status as string }));
}

const { publishInstagramReel, publishInstagramStory } = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

// Суммарно окно ожидания в socialPublish.ts ~282с (4×3с+3×5с+3×10с+3×15с+3×20с+4×30с) —
// с запасом прокручиваем фейковые часы на полчаса.
const FULL_WAIT_WINDOW_MS = 30 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  pendingCreate.mockReset().mockResolvedValue({});
  pendingUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  logSystemError.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishInstagramReel — контейнер пережил окно ожидания", () => {
  it("IN_PROGRESS дольше окна ожидания — pending:true, контейнер сохранён, ЭТО НЕ ОТКАЗ в журнале", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "IN_PROGRESS" });
      return jsonResponse({ id: "container-pending-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishInstagramReel("prop-pending-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/a.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.pending).toBe(true);
    expect(pendingCreate).toHaveBeenCalledWith({
      data: { propertyId: "prop-pending-1", containerId: "container-pending-1", kind: "REEL", storyKind: null, partIndex: null },
    });
    const messages = logSystemError.mock.calls.map((c) => c[1] as string);
    // НЕ начинается с «Публикация в» — иначе routes/properties/list.ts::
    // loadPublishErrorsByChannel показал бы канал красным как отказ (ОБ-000113).
    expect(messages.some((m) => m.startsWith("Публикация в"))).toBe(false);
    expect(messages.some((m) => m.includes("ещё обрабатывается"))).toBe(true);
  });

  it("контейнер отклонён Meta (status_code: ERROR) — честный отказ, запись закрывается как REJECTED", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "ERROR" });
      return jsonResponse({ id: "container-error-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramReel("prop-error-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/b.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.pending).toBeUndefined();
    // Запомнили ДО окна (иначе рестарт внутри окна потерял бы ролик молча),
    // а отказ Meta сразу закрывает запись — фоновому проходу тут делать нечего.
    expect(pendingCreate).toHaveBeenCalled();
    expect(resolutions()).toEqual([{ containerId: "container-error-1", status: "REJECTED" }]);
    expect(result.error).toMatch(/ERROR/);
  });

  it("сохранить отложенный контейнер не удалось — это уже честный отказ, а не «обрабатывается» (иначе работа теряется молча)", async () => {
    pendingCreate.mockRejectedValueOnce(new Error("нет связи с базой"));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "IN_PROGRESS" });
      return jsonResponse({ id: "container-pending-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishInstagramReel("prop-pending-2", "ig-user-1", "token", "https://crm.example/uploads/handoff/c.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.pending).toBeUndefined();
    const messages = logSystemError.mock.calls.map((c) => c[1] as string);
    expect(messages.some((m) => m.startsWith("Публикация в Instagram") && m.includes("не удалось сохранить"))).toBe(true);
  });

  it("контейнер записан ДО ожидания и закрыт как PUBLISHED после успешной публикации", async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) {
        statusCalls++;
        // Первый опрос застаёт обработку — значит запись обязана существовать
        // ещё ДО того, как контейнер стал готов.
        if (statusCalls === 1) {
          expect(pendingCreate).toHaveBeenCalledTimes(1);
          return jsonResponse({ status_code: "IN_PROGRESS" });
        }
        return jsonResponse({ status_code: "FINISHED" });
      }
      if (url.includes("media_publish")) return jsonResponse({ id: "post-1" });
      return jsonResponse({ id: "container-ok-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishInstagramReel("prop-ok-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/e.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(resolutions()).toEqual([{ containerId: "container-ok-1", status: "PUBLISHED" }]);
  });
});

describe("publishInstagramStory — тот же pending, с storyKind/partIndex", () => {
  it("IN_PROGRESS дольше окна ожидания — сохраняет kind=STORY, storyKind=VIDEO и переданный partIndex", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "IN_PROGRESS" });
      return jsonResponse({ id: "story-container-pending-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishInstagramStory("prop-pending-3", "ig-user-1", "token", "https://crm.example/uploads/handoff/d.mp4", 2);
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.pending).toBe(true);
    expect(pendingCreate).toHaveBeenCalledWith({
      data: { propertyId: "prop-pending-3", containerId: "story-container-pending-1", kind: "STORY", storyKind: "VIDEO", partIndex: 2 },
    });
  });
});
