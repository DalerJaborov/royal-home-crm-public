import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * СТАТИСТИКА TIKTOK (23.09.2026) — lib/tiktokInsights.ts.
 *
 * По образцу tiktok-publish.test.ts: fetch подменён, ../src/db.js подменён
 * (без реальной БД). Проверяем три вещи:
 *  - аккаунт + ролики собираются в одном ответе, пагинация video/list идёт по
 *    cursor/has_more;
 *  - отказ TikTok по правам (scope_not_authorized) даёт честный
 *    `{ available: false, reason, missingScopes }`, а не бросок исключения;
 *  - ролик из TikTok находит свою карточку объекта по
 *    Property.publishedPostIds.TIKTOK одним findMany, без N+1.
 */

const findMany = vi.fn();
vi.mock("../src/db.js", () => ({
  prisma: {
    property: { findMany: (...args: unknown[]) => findMany(...args) },
    settings: { update: vi.fn().mockResolvedValue({}) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));
const logSystemError = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...args: unknown[]) => logSystemError(...args) }));

const { fetchTikTokInsights, resetTikTokInsightsCache } = await import("../src/lib/tiktokInsights.js");

const CREDS = { clientKey: "ckey", clientSecret: "csecret", refreshToken: "rtoken-1" };

function tokenResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: "acc-1", refresh_token: CREDS.refreshToken }) } as unknown as Response;
}

function scopeErrorResponse(code = "scope_not_authorized", message = "the scope is not authorized") {
  return {
    ok: false,
    status: 403,
    json: async () => ({ data: {}, error: { code, message } }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetTikTokInsightsCache();
});

describe("аккаунт + ролики — счастливый путь", () => {
  it("собирает user/info и обе страницы video/list, находит карточку объекта", async () => {
    findMany.mockResolvedValue([
      { id: "prop-1", publishedPostIds: { TIKTOK: "v-2" } },
      { id: "prop-2", publishedPostIds: { FACEBOOK: "fb-9" } }, // без TikTok — не должен попасть в карту
      { id: "prop-3", publishedPostIds: null },
    ]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/token/")) return tokenResponse();
      if (url.includes("/user/info/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              user: {
                open_id: "open-1",
                display_name: "Royal Home",
                avatar_url: "https://example.com/av.jpg",
                bio_description: "Недвижимость в Душанбе",
                profile_deep_link: "https://www.tiktok.com/@royalhome",
                is_verified: false,
                follower_count: 1200,
                following_count: 10,
                likes_count: 5000,
                video_count: 2,
              },
            },
            error: { code: "ok", message: "" },
          }),
        } as unknown as Response;
      }
      if (url.includes("/video/list/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { cursor?: number };
        if ((body.cursor ?? 0) === 0) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                videos: [{ id: "v-1", title: "Продан за неделю", create_time: 1700000200, view_count: 500, like_count: 40, comment_count: 3, share_count: 1 }],
                cursor: 20,
                has_more: true,
              },
              error: { code: "ok", message: "" },
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              videos: [{ id: "v-2", title: "Квартира в Сино", create_time: 1700000100, view_count: 900, like_count: 80, comment_count: 5, share_count: 2 }],
              cursor: 40,
              has_more: false,
            },
            error: { code: "ok", message: "" },
          }),
        } as unknown as Response;
      }
      throw new Error(`неожиданный URL в тесте: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTikTokInsights(CREDS);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");

    expect(result.account.followerCount).toBe(1200);
    expect(result.account.displayName).toBe("Royal Home");
    expect(result.videos).toHaveLength(2);
    // Новее — первым (v-1, create_time 1700000200 > v-2, 1700000100).
    expect(result.videos[0].id).toBe("v-1");
    expect(result.videos[0].propertyId).toBeNull();
    expect(result.videos[1].id).toBe("v-2");
    expect(result.videos[1].propertyId).toBe("prop-1");

    // Один запрос ко всем объектам, а не по одному на ролик.
    expect(findMany).toHaveBeenCalledTimes(1);

    const videoListCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/video/list/"));
    expect(videoListCalls).toHaveLength(2);
  });

  it("кэш на 15 минут — второй вызов не бьёт по сети снова", async () => {
    findMany.mockResolvedValue([]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token/")) return tokenResponse();
      if (url.includes("/user/info/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { user: { open_id: "o1" } }, error: { code: "ok", message: "" } }),
        } as unknown as Response;
      }
      if (url.includes("/video/list/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok", message: "" } }),
        } as unknown as Response;
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTikTokInsights(CREDS);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchTikTokInsights(CREDS);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("отказ по правам — честный ответ, а не исключение", () => {
  it("scope_not_authorized на user/info — недостающие права user.info.profile/user.info.stats", async () => {
    findMany.mockResolvedValue([]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token/")) return tokenResponse();
      if (url.includes("/user/info/")) return scopeErrorResponse();
      if (url.includes("/video/list/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok", message: "" } }),
        } as unknown as Response;
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTikTokInsights(CREDS);
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.reason).toContain("не хватает прав");
    expect(result.missingScopes.sort()).toEqual(["user.info.profile", "user.info.stats"]);
    // Отказ по правам — ожидаемый результат, не системная ошибка.
    expect(logSystemError).not.toHaveBeenCalled();
  });

  it("scope_not_authorized на video/list — недостающее право video.list", async () => {
    findMany.mockResolvedValue([]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token/")) return tokenResponse();
      if (url.includes("/user/info/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { user: { open_id: "o1" } }, error: { code: "ok", message: "" } }),
        } as unknown as Response;
      }
      if (url.includes("/video/list/")) return scopeErrorResponse();
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTikTokInsights(CREDS);
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(result.missingScopes).toEqual(["video.list"]);
  });

  it("сбой обновления токена — честная причина, не исключение наружу", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token/")) {
        return { ok: false, status: 401, json: async () => ({ error: "invalid_grant" }) } as unknown as Response;
      }
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTikTokInsights(CREDS);
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable");
    expect(logSystemError).toHaveBeenCalled();
  });
});
