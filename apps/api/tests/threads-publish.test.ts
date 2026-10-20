import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Threads (Meta) — публикация видео (23.09.2026, lib/socialPublish.ts).
 * По образцу tiktok-publish.test.ts: global.fetch подменён, настоящий API не
 * дёргается; db.js замокан пустым объектом — publishThreadsVideo/threadsCaption
 * ничего не пишут в БД сами (в отличие от TikTok, который ротирует
 * refresh_token). Таймеры фейковые — тем же приёмом, что
 * social-publish-instagram-pending.test.ts: лесенка опроса контейнера
 * суммарно ждёт ~282с реальных, реальными часами тест был бы недопустимо
 * медленным.
 */

vi.mock("../src/db.js", () => ({
  prisma: { $disconnect: async () => {} },
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn().mockResolvedValue(undefined),
}));

const { publishThreadsVideo, threadsCaption } = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

// Суммарно окно ожидания ~282с (4×3с+3×5с+3×10с+3×15с+3×20с+4×30с, та же
// лесенка, что у Instagram) — с запасом прокручиваем фейковые часы на полчаса.
const FULL_WAIT_WINDOW_MS = 30 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("threadsCaption — обрезка по границе строки, номера сохранены", () => {
  const contactLine = "📲 Пишите в директ или звоните: +992 44 650-14-14";

  it("короткая подпись (≤500) — не меняется", () => {
    const short = `Хорошая квартира\n${contactLine}`;
    expect(threadsCaption(short)).toBe(short);
  });

  it("длинная подпись — обрезана до ≤500, последняя строка с номерами сохранена целиком", () => {
    const bodyLine = "Просторная квартира с ремонтом, мебелью и техникой, у самого центра города. ".repeat(10);
    const long = `${bodyLine}\n${contactLine}`;
    expect(long.length).toBeGreaterThan(500);

    const result = threadsCaption(long);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result.endsWith(contactLine)).toBe(true);
    expect(result).toContain("+992 44 650-14-14");
  });

  it("режет ЦЕЛЫМИ строками — обрезанный текст не содержит рваной последней строки тела", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Строка номер ${i} с каким-то текстом для объёма`);
    const long = [...lines, contactLine].join("\n");
    const result = threadsCaption(long);
    const resultLines = result.split("\n");
    const lastBodyLine = resultLines[resultLines.length - 2];
    // Каждая сохранённая строка тела — ПОЛНОСТЬЮ одна из исходных строк, не обрубок.
    expect(lines).toContain(lastBodyLine);
  });
});

describe("publishThreadsVideo — двухшаговый протокол (контейнер → publish → permalink)", () => {
  const creds = { userId: "th-user-1", accessToken: "th-token-1" };

  it("FINISHED сразу — публикует и возвращает permalink", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/threads_publish")) return jsonResponse({ id: "post-1" });
      if (url.includes("fields=status")) return jsonResponse({ status: "FINISHED" });
      if (url.includes("fields=permalink")) return jsonResponse({ permalink: "https://www.threads.net/@royalhome/post/post-1" });
      return jsonResponse({ id: "container-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishThreadsVideo(creds, "https://crm.example/uploads/handoff/a.mp4", "Подпись объекта");

    expect(result.ok).toBe(true);
    expect(result.channel).toBe("THREADS");
    expect(result.postId).toBe("post-1");
    expect(result.permalink).toBe("https://www.threads.net/@royalhome/post/post-1");
  });

  it("ERROR — ok:false с текстом error_message, публикация не вызывается", async () => {
    const publishCalled = vi.fn();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/threads_publish")) {
        publishCalled();
        return jsonResponse({ id: "post-x" });
      }
      if (url.includes("fields=status")) return jsonResponse({ status: "ERROR", error_message: "Видео повреждено" });
      return jsonResponse({ id: "container-err" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishThreadsVideo(creds, "https://crm.example/uploads/handoff/b.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Видео повреждено");
    expect(publishCalled).not.toHaveBeenCalled();
  });

  it("IN_PROGRESS дольше окна ожидания — pending:true, это НЕ отказ", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("fields=status")) return jsonResponse({ status: "IN_PROGRESS" });
      return jsonResponse({ id: "container-pending" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = publishThreadsVideo(creds, "https://crm.example/uploads/handoff/c.mp4", "Подпись");
    await vi.advanceTimersByTimeAsync(FULL_WAIT_WINDOW_MS);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.pending).toBe(true);
  });

  it("не подключено (нет userId/accessToken) — честный отказ без сетевого вызова", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishThreadsVideo({}, "https://crm.example/uploads/handoff/d.mp4", "Подпись");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не подключён/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
