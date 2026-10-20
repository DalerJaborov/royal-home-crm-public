import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Публикация Reels в Instagram (Graph API, двухшаговый протокол) —
 * lib/socialPublish.ts::publishInstagramReel. Настоящий Graph API здесь не
 * дёргается — подменяем global.fetch тем же приёмом, что и остальные тесты
 * внешних вызовов (client-avatar.test.ts и др.). Проверяем ровно то, что
 * решает наш код: cover_url (31.08.2026, lib/video/coverStill.ts) уходит в
 * тело запроса создания контейнера, когда обложка есть, и не уходит вовсе,
 * когда её нет — Instagram в этом случае сам выберет кадр по thumb_offset=0.
 */

const { publishInstagramReel } = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publishInstagramReel", () => {
  it("с обложкой — cover_url уходит в тело создания контейнера", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-1" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "container-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramReel(
      "prop-1",
      "ig-user-1",
      "token",
      "https://crm.example/uploads/automontage/a.mp4",
      "Подпись",
      "https://crm.example/uploads/automontage/covers/a.jpg"
    );

    expect(result.ok).toBe(true);
    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "REELS");
    expect(createCall?.body).toMatchObject({
      media_type: "REELS",
      video_url: "https://crm.example/uploads/automontage/a.mp4",
      cover_url: "https://crm.example/uploads/automontage/covers/a.jpg",
    });
  });

  it("без обложки — cover_url в теле запроса отсутствует вовсе (не пустая строка/null)", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-2" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "container-2" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await publishInstagramReel("prop-1", "ig-user-1", "token", "https://crm.example/uploads/automontage/b.mp4", "Подпись", null);

    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "REELS");
    expect(createCall?.body).not.toHaveProperty("cover_url");
  });
});

/**
 * СОАВТОРЫ (26.09.2026) — до 3 ников уходят в тело создания контейнера полем
 * `collaborators`, и только когда список не пуст: пустой/не переданный массив
 * оставляет тело байт в байт таким же, как до этой функции (см. brief
 * instagram-collaborators-hashtags-26-09.md). Отказ Meta именно из-за
 * соавтора не должен ронять публикацию — повтор без них, с пометкой в note.
 */
describe("publishInstagramReel — соавторы", () => {
  it("непустой список соавторов уходит в тело создания контейнера", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-3" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "container-3" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramReel(
      "prop-1",
      "ig-user-1",
      "token",
      "https://crm.example/uploads/automontage/c.mp4",
      "Подпись",
      null,
      ["noza", "bob.k"]
    );

    expect(result.ok).toBe(true);
    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "REELS");
    expect(createCall?.body).toMatchObject({ collaborators: ["noza", "bob.k"] });
  });

  it("пустой список соавторов — поле collaborators в теле отсутствует, как раньше", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-3b" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      return jsonResponse({ id: "container-3b" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await publishInstagramReel(
      "prop-1",
      "ig-user-1",
      "token",
      "https://crm.example/uploads/automontage/c2.mp4",
      "Подпись",
      null,
      []
    );

    const createCall = calls.find((c) => (c.body as { media_type?: string })?.media_type === "REELS");
    expect(createCall?.body).not.toHaveProperty("collaborators");
  });

  it("Meta отклонила именно соавторов — повтор без них проходит, note объясняет причину", async () => {
    let createAttempts = 0;
    const createBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-4" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      // Эндпоинт создания контейнера — считаем попытки отдельно.
      createAttempts++;
      createBodies.push(body);
      if (createAttempts === 1) {
        return jsonResponse({ error: { message: "Invalid collaborators username: baduser" } }, false, 400);
      }
      return jsonResponse({ id: "container-4" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramReel(
      "prop-1",
      "ig-user-1",
      "token",
      "https://crm.example/uploads/automontage/d.mp4",
      "Подпись",
      null,
      ["baduser"]
    );

    expect(result.ok).toBe(true);
    expect(result.note).toContain("соавторы не приняты");
    expect(createAttempts).toBe(2);
    expect(createBodies[0]).toHaveProperty("collaborators");
    expect(createBodies[1]).not.toHaveProperty("collaborators");
  });

  it("отказ Meta БЕЗ упоминания соавторов не запускает повтор — обычный отказ", async () => {
    let createAttempts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/media_publish")) return jsonResponse({ id: "post-5" });
      if (url.includes("status_code")) return jsonResponse({ status_code: "FINISHED" });
      createAttempts++;
      return jsonResponse({ error: { message: "Invalid video format" } }, false, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishInstagramReel(
      "prop-1",
      "ig-user-1",
      "token",
      "https://crm.example/uploads/automontage/e.mp4",
      "Подпись",
      null,
      ["someone"]
    );

    expect(result.ok).toBe(false);
    expect(createAttempts).toBe(1); // ни одного повтора — отказ не про соавторов
  });
});
