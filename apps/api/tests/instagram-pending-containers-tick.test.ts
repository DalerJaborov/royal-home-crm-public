import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ДОЗАВЕРШЕНИЕ ОТЛОЖЕННЫХ КОНТЕЙНЕРОВ INSTAGRAM (случай №111, 21.09.2026) —
 * lib/instagramPendingContainers.ts::runInstagramPendingContainersTick. Сеть
 * (Graph API), БД и applySucceededPublishResults подменены — тест не ходит ни
 * в реальную Meta, ни в реальную базу; проверяем только логику самого тика:
 *  - контейнер старше 24 часов (срок жизни у Meta) — EXPIRED, ни одного
 *    HTTP-запроса на него не уходит;
 *  - Meta вернула ERROR — REJECTED, честный отказ в журнале;
 *  - контейнер ещё IN_PROGRESS — остаётся PENDING, ни ошибки, ни публикации;
 *  - контейнер FINISHED, kind=REEL — публикуется, карточка дописывается ТЕМ ЖЕ
 *    путём (applySucceededPublishResults), что и обычная успешная публикация;
 *  - контейнер FINISHED, kind=STORY — создаётся PropertyStoryPost, carточка
 *    (publishedChannels/instagramUrl) НЕ трогается.
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { pendingFindMany, pendingUpdate, pendingUpdateMany, storyPostCreate, propertyFindMany } = vi.hoisted(() => ({
  pendingFindMany: vi.fn(async () => [] as unknown[]),
  pendingUpdate: vi.fn(async () => ({})),
  pendingUpdateMany: vi.fn(async () => ({ count: 0 })),
  storyPostCreate: vi.fn(async () => ({})),
  /** Живые объекты прохода. По умолчанию отвечает «все спрошенные на месте» —
   *  тесты про Корзину подменяют ответ точечно, а остальные о ней не про то и
   *  не должны зависеть от того, какие propertyId в них написаны. */
  propertyFindMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({ id }))
  ),
}));
vi.mock("../src/db.js", () => ({
  prisma: {
    pendingInstagramContainer: { findMany: pendingFindMany, update: pendingUpdate, updateMany: pendingUpdateMany },
    propertyStoryPost: { create: storyPostCreate },
    property: { findMany: propertyFindMany },
    $disconnect: vi.fn().mockResolvedValue(undefined),
    // Статус контейнера и строка истории публикуются одной транзакцией
    // (22.09.2026) — форма-массив, как у настоящего prisma.$transaction:
    // просто ждёт каждый переданный промис по очереди.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const { loadCredentials, instagramTokenIdentity } = vi.hoisted(() => ({
  loadCredentials: vi.fn(async () => ({ igToken: "token" }) as { igToken?: string }),
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials,
  instagramTokenIdentity,
}));

const { applySucceededPublishResults } = vi.hoisted(() => ({
  applySucceededPublishResults: vi.fn(async () => ({ instagramUrl: "https://instagram.com/reel/xyz", wentAvailable: true, blockers: [] })),
}));
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  applySucceededPublishResults,
}));

const { runInstagramPendingContainersTick, cancelPendingInstagramContainersForTrashed } = await import(
  "../src/lib/instagramPendingContainers.js"
);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function row(overrides: Partial<{
  id: string;
  propertyId: string;
  containerId: string;
  kind: string;
  storyKind: string | null;
  partIndex: number | null;
  createdAt: Date;
  lastCheckedAt: Date | null;
}> = {}) {
  return {
    id: "row-1",
    propertyId: "prop-1",
    containerId: "container-1",
    kind: "REEL",
    storyKind: null,
    partIndex: null,
    // Десять минут назад: старше окна «у контейнера есть живой хозяин»
    // (INSTAGRAM_CONTAINER_OWNER_STALE_MS), иначе проход правильно не трогает
    // контейнер, который прямо сейчас ждёт живой запрос.
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    lastCheckedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  pendingFindMany.mockReset();
  pendingUpdate.mockReset().mockResolvedValue({});
  pendingUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  propertyFindMany
    .mockReset()
    .mockImplementation(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id })));
  storyPostCreate.mockReset().mockResolvedValue({});
  loadCredentials.mockReset().mockResolvedValue({ igToken: "token" });
  instagramTokenIdentity.mockReset().mockResolvedValue({ ok: true, id: "ig-user-1" });
  applySucceededPublishResults.mockReset().mockResolvedValue({ instagramUrl: "https://instagram.com/reel/xyz", wentAvailable: true, blockers: [] });
  logSystemError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runInstagramPendingContainersTick", () => {
  it("контейнер старше 24 часов — EXPIRED, ни одного HTTP-запроса на Meta", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — контейнер должен быть признан протухшим до сетевого запроса");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })]);

    const result = await runInstagramPendingContainersTick();

    expect(result.expired).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "EXPIRED" }),
    });
    expect(logSystemError.mock.calls.some((c) => (c[1] as string).includes("протух"))).toBe(true);
  });

  it("Meta вернула ERROR — REJECTED, честный отказ («Публикация в Instagram... не удалась»)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "ERROR" });
      throw new Error("не должны были дойти до media_publish");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row()]);

    const result = await runInstagramPendingContainersTick();

    expect(result.rejected).toBe(1);
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "REJECTED" }),
    });
    expect(logSystemError.mock.calls.some((c) => (c[1] as string).startsWith("Публикация в Instagram"))).toBe(true);
  });

  it("контейнер ещё IN_PROGRESS — остаётся PENDING, ни отказа, ни публикации", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "IN_PROGRESS" });
      throw new Error("не должны были дойти до media_publish");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row()]);

    const result = await runInstagramPendingContainersTick();

    expect(result.published).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.expired).toBe(0);
    // Только lastCheckedAt — ни REJECTED, ни PUBLISHED, ни EXPIRED статус не выставлялся.
    for (const call of pendingUpdate.mock.calls) {
      expect((call[0] as { data: Record<string, unknown> }).data.status).toBeUndefined();
    }
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("FINISHED, kind=REEL — публикует и дописывает карточку через applySucceededPublishResults", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      if (url.includes("media_publish")) return jsonResponse({ id: "post-99" });
      if (url.includes("permalink")) return jsonResponse({ permalink: "https://instagram.com/reel/xyz" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ kind: "REEL" })]);

    const result = await runInstagramPendingContainersTick();

    expect(result.published).toBe(1);
    expect(applySucceededPublishResults).toHaveBeenCalledWith(
      "prop-1",
      [{ channel: "INSTAGRAM", postId: "post-99" }],
      "https://instagram.com/reel/xyz"
    );
    expect(storyPostCreate).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "PUBLISHED" }),
    });
  });

  it("FINISHED, kind=STORY — создаёт PropertyStoryPost, publishedChannels не трогает", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      if (url.includes("media_publish")) return jsonResponse({ id: "story-post-77" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ kind: "STORY", storyKind: "PRICE_DROP", partIndex: 0 })]);

    const result = await runInstagramPendingContainersTick();

    expect(result.published).toBe(1);
    expect(applySucceededPublishResults).not.toHaveBeenCalled();
    expect(storyPostCreate).toHaveBeenCalledWith({
      data: { propertyId: "prop-1", channel: "INSTAGRAM", mediaId: "story-post-77", partIndex: 0, kind: "PRICE_DROP" },
    });
  });

  /**
   * ОБЪЕКТ УШЁЛ В КОРЗИНУ, ПОКА КОНТЕЙНЕР ЖДАЛ (22.09.2026). Контейнер живёт у
   * Meta сутки — без этой проверки проход опубликовал бы ролик удалённого
   * объекта на публичной странице агентства через часы после удаления, и
   * заметить это можно было только глазами в Instagram.
   */
  it("объекта больше нет — CANCELLED, ни одного HTTP-запроса на Meta", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — объекта больше нет");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row()]);
    propertyFindMany.mockResolvedValueOnce([]);

    const result = await runInstagramPendingContainersTick();

    expect(result.cancelled).toBe(1);
    expect(result.published).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
  });

  it("живой объект среди удалённых разбирается как обычно", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      if (url.includes("media_publish")) return jsonResponse({ id: "post-42" });
      if (url.includes("permalink")) return jsonResponse({ permalink: "https://instagram.com/reel/xyz" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([
      row({ id: "row-dead", propertyId: "prop-dead", containerId: "container-dead" }),
      row({ id: "row-alive", propertyId: "prop-1", containerId: "container-alive" }),
    ]);
    propertyFindMany.mockResolvedValueOnce([{ id: "prop-1" }]);

    const result = await runInstagramPendingContainersTick();

    expect(result).toMatchObject({ cancelled: 1, published: 1 });
  });

  /* ПРОДАН / СНЯТ, ПОКА КОНТЕЙНЕР ЖДАЛ META (25.09.2026, Б1) — тот же
     предикат, что у задания публикации (lib/videoHandoff.ts). */
  it.each(["WITHDRAWN", "SOLD", "RESERVED"])("объект %s — Reels отменён, ни одного HTTP-запроса, одна запись в журнал", async (status) => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — объект вне продажи");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row()]);
    propertyFindMany.mockResolvedValueOnce([{ id: "prop-1", status }]);

    const result = await runInstagramPendingContainersTick();

    expect(result).toMatchObject({ cancelled: 1, published: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applySucceededPublishResults).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
    expect(logSystemError.mock.calls.filter((c) => String(c[1]).includes("отложенный контейнер отменён"))).toHaveLength(1);
  });

  it("проданный объект: история «Продано» (storyKind SOLD) НЕ отменяется", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      if (url.includes("media_publish")) return jsonResponse({ id: "story-9" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ kind: "STORY", storyKind: "SOLD", partIndex: 0 })]);
    propertyFindMany.mockResolvedValueOnce([{ id: "prop-1", status: "SOLD" }]);

    const result = await runInstagramPendingContainersTick();

    expect(result).toMatchObject({ cancelled: 0, published: 1 });
  });

  /* АУДИТ 04.10.2026, PUB03: у «Продано» с 28.09 свой kind SOLD, поэтому реклама
     живого объекта (карточка, «цена снижена», видео-история), не дождавшаяся
     Meta, гаснет вместе с Reels, когда объект ушёл с продажи. */
  it.each(["CARD", "PRICE_DROP", "VIDEO"])("проданный объект: отложенная история %s отменена, media_publish не вызван", async (storyKind) => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — объект вне продажи");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ kind: "STORY", storyKind, partIndex: 0 })]);
    propertyFindMany.mockResolvedValueOnce([{ id: "prop-1", status: "SOLD" }]);

    const result = await runInstagramPendingContainersTick();

    expect(result).toMatchObject({ cancelled: 1, published: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingUpdate).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
  });
});

describe("cancelPendingInstagramContainersForTrashed", () => {
  it("гасит только ждущие контейнеры перечисленных объектов", async () => {
    pendingUpdateMany.mockResolvedValueOnce({ count: 2 });

    expect(await cancelPendingInstagramContainersForTrashed(["prop-1", "prop-2"])).toBe(2);
    expect(pendingUpdateMany).toHaveBeenCalledWith({
      where: { propertyId: { in: ["prop-1", "prop-2"] }, status: "PENDING" },
      data: expect.objectContaining({ status: "CANCELLED" }),
    });
  });

  it("пустой список — ни одного запроса в базу", async () => {
    expect(await cancelPendingInstagramContainersForTrashed([])).toBe(0);
    expect(pendingUpdateMany).not.toHaveBeenCalled();
  });
});

describe("runInstagramPendingContainersTick (прочее)", () => {
  it("одна запись упала неожиданно — не роняет проход по остальным", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const key = String(init?.headers ? JSON.stringify(init.headers) : "");
      if (url.includes("container-bad") || key) {
        // первая запись бросает через instagramTokenIdentity ниже, а не сеть
      }
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      if (url.includes("media_publish")) return jsonResponse({ id: "post-ok" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    instagramTokenIdentity
      .mockImplementationOnce(async () => {
        throw new Error("сеть моргнула");
      })
      .mockImplementation(async () => ({ ok: true, id: "ig-user-1" }));
    pendingFindMany.mockResolvedValueOnce([row({ id: "row-bad", propertyId: "prop-bad", containerId: "container-bad" }), row({ id: "row-ok", propertyId: "prop-ok", containerId: "container-ok" })]);

    const result = await runInstagramPendingContainersTick();

    expect(result.published).toBe(1);
    expect(logSystemError.mock.calls.some((c) => (c[1] as string).includes("упало неожиданно"))).toBe(true);
  });
  it("контейнер ещё ждёт живой процесс (свежий lastCheckedAt) — проход его не трогает, второго поста не будет", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — контейнером занят живой процесс");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ lastCheckedAt: new Date(Date.now() - 30 * 1000) })]);

    const result = await runInstagramPendingContainersTick();

    expect(result).toEqual({ published: 0, rejected: 0, expired: 0, cancelled: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingUpdate).not.toHaveBeenCalled();
  });

  it("свежесозданный контейнер (без lastCheckedAt) — тоже не трогаем: его только что создал живой запрос", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("не должны были дойти до сети — контейнер создан только что");
    });
    vi.stubGlobal("fetch", fetchMock);
    pendingFindMany.mockResolvedValueOnce([row({ createdAt: new Date() })]);

    const result = await runInstagramPendingContainersTick();

    expect(result.published).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
