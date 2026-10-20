import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ИСТОРИИ INSTAGRAM (21.09.2026) — lib/socialPublish.ts::publishInstagramStory /
 * checkInstagramPublishingLimit, и lib/instagramStories.ts::planStorySegments.
 * Тот же приём подмены global.fetch, что и у Reels (social-publish-instagram.test.ts) —
 * настоящий Graph API не дёргается.
 */

const { publishInstagramStory, publishInstagramStoryImage, checkInstagramPublishingLimit } = await import("../src/lib/socialPublish.js");
const { planStorySegments } = await import("../src/lib/instagramStories.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishInstagramStory", () => {
  it("уходит двумя шагами и media_type=STORIES, без caption/cover_url", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "story-post-1" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "story-container-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramStory("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/a.mp4");

    expect(result.ok).toBe(true);
    expect(result.postId).toBe("story-post-1");
    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "STORIES");
    expect(createCall?.body).toMatchObject({ media_type: "STORIES", video_url: "https://crm.example/uploads/handoff/a.mp4" });
    expect(createCall?.body).not.toHaveProperty("caption");
    expect(createCall?.body).not.toHaveProperty("cover_url");

    const publishCall = calls.find((c) => (c.body as { creation_id?: string })?.creation_id);
    expect(publishCall?.body).toMatchObject({ creation_id: "story-container-1" });
  });

  it("контейнер вернул ERROR — честный отказ, без второй попытки публикации", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("status_code")) return jsonResponse({ status_code: "ERROR" });
      if (url.includes("/media_publish")) throw new Error("не должны были дойти сюда");
      return jsonResponse({ id: "story-container-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramStory("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/b.mp4");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ERROR/);
  });

  it("Graph API отказал уже на создании контейнера — возвращает текст ошибки Meta", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "Media type is invalid" } }, false, 400));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramStory("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/c.mp4");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Media type is invalid");
  });
});

describe("publishInstagramStoryImage", () => {
  it("уходит media_type=STORIES и image_url (не video_url), без caption/cover_url", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "story-image-post-1" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "story-image-container-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramStoryImage("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/card.jpg");

    expect(result.ok).toBe(true);
    expect(result.postId).toBe("story-image-post-1");
    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "STORIES");
    expect(createCall?.body).toMatchObject({ media_type: "STORIES", image_url: "https://crm.example/uploads/handoff/card.jpg" });
    expect(createCall?.body).not.toHaveProperty("video_url");
    expect(createCall?.body).not.toHaveProperty("caption");
    expect(createCall?.body).not.toHaveProperty("cover_url");

    const publishCall = calls.find((c) => (c.body as { creation_id?: string })?.creation_id);
    expect(publishCall?.body).toMatchObject({ creation_id: "story-image-container-1" });
  });

  it("Graph API отказал на создании контейнера картинки — возвращает текст ошибки Meta", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "Invalid image URL" } }, false, 400));
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramStoryImage("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/bad.jpg");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid image URL");
  });

  /**
   * БАГ (найден 28.09.2026 при разборе задания на истории Facebook):
   * storyKind был зашит константой "PRICE_DROP" для ЛЮБОЙ картинки — история
   * «продано» или карточка объекта, не успевшая обработаться контейнером в
   * отведённое окно, дозавершилась бы фоном и записала бы себя как PRICE_DROP.
   * storyMeta уходит в rememberInstagramContainer (prisma.pendingInstagramContainer.create),
   * вызывается на КАЖДОЙ публикации истории, ДО ответа Meta — удобная точка
   * проверки, не завязанная на разбор тела запроса Graph API.
   */
  it("storyKind передаётся параметром — не зашит PRICE_DROP для любой картинки", async () => {
    const { prisma } = await import("../src/db.js");
    const rememberSpy = vi.spyOn(prisma.pendingInstagramContainer, "create").mockResolvedValue({} as never);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/media_publish")) return jsonResponse({ id: "story-image-post-2" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "story-image-container-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // По умолчанию (без 5-го аргумента) поведение сохранено — PRICE_DROP.
    await publishInstagramStoryImage("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/default.jpg");
    expect(rememberSpy).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ storyKind: "PRICE_DROP" }) }));

    await publishInstagramStoryImage("prop-1", "ig-user-1", "token", "https://crm.example/uploads/handoff/sold.jpg", "SOLD");
    expect(rememberSpy).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ storyKind: "SOLD" }) }));
  });
});

describe("checkInstagramPublishingLimit", () => {
  it("считает остаток от quota_total - quota_usage", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ quota_usage: 45, config: { quota_total: 50 } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkInstagramPublishingLimit("ig-user-1", "token");
    expect(result).toEqual({ ok: true, remaining: 5 });
  });

  it("Meta вернула непонятный ответ — честный отказ, не выдумываем число", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkInstagramPublishingLimit("ig-user-1", "token");
    expect(result.ok).toBe(false);
  });
});

describe("planStorySegments", () => {
  it("ролик короче 60 секунд — одна часть, без нарезки", () => {
    expect(planStorySegments(22)).toEqual([{ startSec: 0, durationSec: 22 }]);
  });

  it("ровно 60 секунд — тоже одна часть", () => {
    expect(planStorySegments(60)).toEqual([{ startSec: 0, durationSec: 60 }]);
  });

  it("67.5 секунды (замер на проде) — две РОВНЫЕ части по ≤60с, не 60+7.5", () => {
    const segments = planStorySegments(67.5);
    expect(segments).toHaveLength(2);
    for (const s of segments) expect(s.durationSec).toBeLessThanOrEqual(60);
    expect(segments[0].startSec).toBe(0);
    expect(segments[1].startSec).toBeCloseTo(33.75, 5);
    expect(segments[0].durationSec).toBeCloseTo(33.75, 5);
    expect(segments[1].durationSec).toBeCloseTo(33.75, 5);
    // Части идут подряд без разрывов и без наложений.
    expect(segments[1].startSec).toBeCloseTo(segments[0].startSec + segments[0].durationSec, 5);
  });

  it("длительность нулевая/неизвестна — пустой план, не публикуем ролик нулевой длины", () => {
    expect(planStorySegments(0)).toEqual([]);
    expect(planStorySegments(-1)).toEqual([]);
    expect(planStorySegments(Number.NaN)).toEqual([]);
  });
});
