import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Удаление Instagram Reels и запасной идентификатор Facebook (20.09.2026) —
 * lib/socialPublish.ts::deleteInstagramMedia/resolveInstagramBusinessAccountId/
 * findInstagramMediaIdByPermalink/fetchFacebookVideoPostId (внутри
 * publishFacebookVideo). Настоящий Graph API здесь не дёргается — подменяем
 * global.fetch тем же приёмом, что и соседние тесты (social-publish-youtube.test.ts).
 *
 * КОНТЕКСТ, ПРОВЕРЕННЫЙ ЖИВЬЁМ 20.09.2026 (не гипотеза): удаление опубликованного
 * Instagram Reels через Graph API работает — но только токеном через Facebook
 * Login на graph.facebook.com (`instagram_basic` + `instagram_manage_contents`),
 * НЕ тем `metaIgToken`, что ходит на graph.instagram.com через прокси для
 * переписки. Отсюда прямой хост БЕЗ instagramApiUrl/instagramRequest во всех
 * функциях ниже — см. докстринг deleteInstagramMedia.
 */

const {
  deleteFacebookVideo,
  deleteInstagramMedia,
  resolveInstagramBusinessAccountId,
  findInstagramMediaIdByPermalink,
  publishFacebookVideo,
} = await import("../src/lib/socialPublish.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Ответ Graph API на DELETE/GET несуществующего объекта — случай №112, формат
 *  проверен живьём токеном страницы. */
function ghostErrorBody() {
  return {
    error: {
      message: "Unsupported get request. Object with ID '1579777273883019' does not exist, cannot be loaded due to missing permission...",
      type: "GraphMethodException",
      code: 100,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deleteInstagramMedia", () => {
  it("успешное удаление — DELETE напрямую на graph.facebook.com, без прокси", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("https://graph.facebook.com/");
      expect(url).toContain("access_token=ig-manage-token");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ success: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteInstagramMedia("ig-media-1", "ig-manage-token");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("«объекта не существует» (случай №112) — ok:true, ghost:true, не отказ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ghostErrorBody(), false, 400)));

    const result = await deleteInstagramMedia("ig-media-gone", "ig-manage-token");

    expect(result).toEqual({ ok: true, ghost: true });
  });

  it("настоящий отказ (токен без прав) — ok:false, без ghost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { message: "У приложения нет права instagram_manage_contents", code: 200 } }, false, 403)
      )
    );

    const result = await deleteInstagramMedia("ig-media-1", "ig-manage-token");

    expect(result.ok).toBe(false);
    expect(result.ghost).toBeUndefined();
    expect(result.error).toContain("instagram_manage_contents");
  });

  it("code:100 без «does not exist» в тексте — настоящий отказ, а не ghost", async () => {
    // Голого code===100 мало — у него есть причины, которые НЕ значат «объекта нет»
    // (см. комментарий isGhostObjectError в socialPublish.ts).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "Unsupported request format", code: 100 } }, false, 400))
    );

    const result = await deleteInstagramMedia("ig-media-1", "ig-manage-token");

    expect(result.ok).toBe(false);
    expect(result.ghost).toBeUndefined();
  });
});

describe("deleteFacebookVideo — «объекта не существует»", () => {
  it("ghost:true на code:100 + does not exist (случай №112)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(ghostErrorBody(), false, 400)));

    const result = await deleteFacebookVideo("1579777273883019", "page-token");

    expect(result).toEqual({ ok: true, ghost: true });
  });
});

describe("resolveInstagramBusinessAccountId", () => {
  it("читает instagram_business_account.id со Страницы", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("https://graph.facebook.com/");
      expect(url).toContain("873975375804470");
      expect(url).toContain("fields=instagram_business_account");
      return jsonResponse({ instagram_business_account: { id: "17841477393005072" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const id = await resolveInstagramBusinessAccountId("ig-manage-token", "873975375804470");

    expect(id).toBe("17841477393005072");
  });

  it("Страница не привязана к Instagram — null, не бросает", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));

    const id = await resolveInstagramBusinessAccountId("ig-manage-token", "873975375804470");

    expect(id).toBeNull();
  });

  it("сеть недоступна — null, не бросает", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );

    const id = await resolveInstagramBusinessAccountId("ig-manage-token", "873975375804470");

    expect(id).toBeNull();
  });
});

describe("findInstagramMediaIdByPermalink", () => {
  it("находит совпадение на первой странице", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "media-1", permalink: "https://www.instagram.com/reel/AAA/" },
          { id: "media-2", permalink: "https://www.instagram.com/reel/BBB/" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/BBB/");

    expect(result).toEqual({ status: "found", mediaId: "media-2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("идёт по страницам (paging.next), пока не найдёт", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return jsonResponse({
          data: [{ id: "media-1", permalink: "https://www.instagram.com/reel/AAA/" }],
          paging: { next: "https://graph.facebook.com/v23.0/ig-user-1/media?after=cursor2" },
        });
      }
      return jsonResponse({ data: [{ id: "media-2", permalink: "https://www.instagram.com/reel/TARGET/" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/TARGET/");

    expect(result).toEqual({ status: "found", mediaId: "media-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("нет совпадения нигде в ленте, дочитана до конца — not_found, а не бросает", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [{ id: "media-1", permalink: "https://www.instagram.com/reel/OTHER/" }] }))
    );

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/TARGET/");

    expect(result).toEqual({ status: "not_found" });
  });

  it("HTTP-отказ Graph API — incomplete с причиной, не not_found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "токен просрочен" } }, false, 401)));

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/TARGET/");

    expect(result.status).toBe("incomplete");
    expect(result.status === "incomplete" && result.reason).toContain("401");
  });

  it("сеть недоступна — incomplete, не бросает", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/TARGET/");

    expect(result.status).toBe("incomplete");
  });

  it("лента длиннее лимита обхода — incomplete, а НЕ not_found (не дочитали, а не «дочитали и не нашли»)", async () => {
    // 4 страницы по 100 = 400 записей > IG_MEDIA_SEARCH_LIMIT (300) — обрыв
    // должен случиться до того, как искомая ссылка (её тут вообще нет) была бы
    // «не найдена окончательно».
    let page = 0;
    const fetchMock = vi.fn(async () => {
      page++;
      const data = Array.from({ length: 100 }, (_, i) => ({
        id: `media-${page}-${i}`,
        permalink: `https://www.instagram.com/reel/P${page}I${i}/`,
      }));
      return jsonResponse({
        data,
        paging: { next: `https://graph.facebook.com/v23.0/ig-user-1/media?after=cursor${page}` },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await findInstagramMediaIdByPermalink("ig-user-1", "ig-manage-token", "https://www.instagram.com/reel/NEVER/");

    expect(result.status).toBe("incomplete");
    expect(result.status === "incomplete" && result.reason).toContain("300");
    // Ровно 3 страницы (300 записей) — четвёртая не должна была уйти в fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("publishFacebookVideo — сохранение post_id", () => {
  it("после успешной публикации подтягивает post_id и отдаёт его secondaryPostId", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/videos")) return jsonResponse({ id: "fb-video-1" });
      if (url.includes("fields=post_id")) return jsonResponse({ id: "fb-video-1", post_id: "122161721733120295" });
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookVideo("page-1", "page-token", "https://example.com/v.mp4", "Подпись");

    expect(result).toMatchObject({ ok: true, postId: "fb-video-1", secondaryPostId: "122161721733120295" });
  });

  it("post_id не подтянулся — публикация всё равно успешна, просто без secondaryPostId", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/videos")) return jsonResponse({ id: "fb-video-1" });
      throw new Error("сеть недоступна");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await publishFacebookVideo("page-1", "page-token", "https://example.com/v.mp4", "Подпись");

    expect(result.ok).toBe(true);
    expect(result.postId).toBe("fb-video-1");
    expect(result.secondaryPostId).toBeUndefined();
  });
});
