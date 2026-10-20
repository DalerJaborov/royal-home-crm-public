import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Права маркеров одним списком (23.09.2026) — lib/tokenScopes.ts.
 *
 * Владелец: «каждые несколько дней мы выпускаем новые маркеры, потому что там нет
 * каких-то прав». Проверяем то, что делает это невозможным молча: список прав
 * полный, кнопки подключения берут его целиком, а проверка по ответу площадки
 * называет именно недостающие права и не путает отказ по правам с прочими сбоями.
 *
 * БЕЗ БД и без сети: db.js подменён (маркера приложения нет — debug_token идёт
 * самим маркером), fetch подменён на ответы Graph.
 */

vi.mock("../src/db.js", () => ({
  prisma: {
    settings: { findUnique: vi.fn().mockResolvedValue(null) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

const {
  TOKEN_SCOPE_CATALOG,
  classifyGraphDenial,
  describeMissingScopes,
  instagramLoginScopeProbes,
  metaTokenInfo,
  missingScopes,
  scopesForRequest,
} = await import("../src/lib/tokenScopes.js");
const { splitScopes } = await import("../src/lib/socialPublish.js");

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("кнопки подключения просят ВСЕ права из списка", () => {
  /** Та самая поломка: кнопка TikTok просила три права, и каждое переподключение
   *  выдавало маркер без статистики. */
  it("TikTok — все одобренные права через запятую", () => {
    const scope = scopesForRequest("TIKTOK", ",");
    expect(scope.split(",")).toEqual(
      TOKEN_SCOPE_CATALOG.TIKTOK.scopes.filter((s) => !s.awaitingApproval).map((s) => s.scope)
    );
    expect(scope.split(",")).toEqual(expect.arrayContaining(["user.info.basic", "video.upload", "video.publish"]));
  });

  /** Обратная поломка 23.09.2026: кнопка попросила video.list, которого нет в одобренной
   *  версии приложения, и TikTok отказал во входе целиком («Что-то пошло не так… scope»). */
  it("неодобренное право не просится и не числится недостающим", () => {
    expect(scopesForRequest("TIKTOK", ",")).not.toContain("video.list");
    expect(missingScopes("TIKTOK", ["user.info.basic", "video.upload", "video.publish"])).toEqual([]);
  });

  /** 23.09.2026: статистика (аккаунт + ролики) ждёт той же ревизии, что video.list. */
  it("права статистики (user.info.profile/user.info.stats) тоже awaitingApproval и не просятся у прод-приложения", () => {
    const profile = TOKEN_SCOPE_CATALOG.TIKTOK.scopes.find((s) => s.scope === "user.info.profile");
    const stats = TOKEN_SCOPE_CATALOG.TIKTOK.scopes.find((s) => s.scope === "user.info.stats");
    expect(profile?.awaitingApproval).toBeTruthy();
    expect(stats?.awaitingApproval).toBeTruthy();
    expect(scopesForRequest("TIKTOK", ",")).not.toContain("user.info.profile");
    expect(scopesForRequest("TIKTOK", ",")).not.toContain("user.info.stats");
    expect(missingScopes("TIKTOK", ["user.info.basic", "video.upload", "video.publish"])).toEqual([]);
  });

  /**
   * Песочница (client key начинается с "sb") может просить ещё не одобренные
   * права — ревью TikTok для sandbox-приложений не требуется. Прод-приложению
   * ("aw…") их просить нельзя (см. routes/tiktok.ts::oauth/start).
   */
  it("includeAwaitingApproval — песочница получает все права, включая awaitingApproval", () => {
    const sandboxScope = scopesForRequest("TIKTOK", ",", { includeAwaitingApproval: true }).split(",");
    expect(sandboxScope).toEqual(TOKEN_SCOPE_CATALOG.TIKTOK.scopes.map((s) => s.scope));
    expect(sandboxScope).toEqual(
      expect.arrayContaining(["video.list", "user.info.profile", "user.info.stats"])
    );
  });

  it("у каждого права в списке есть объяснение, для чего оно", () => {
    for (const spec of Object.values(TOKEN_SCOPE_CATALOG)) {
      expect(spec.scopes.length).toBeGreaterThan(0);
      for (const s of spec.scopes) expect(s.forWhat.length).toBeGreaterThan(3);
    }
  });

  /** Страница Facebook: комментарии (23.09.2026, находка треда о модерации). */
  it("маркер Страницы включает права на чтение и скрытие комментариев", () => {
    const scopes = TOKEN_SCOPE_CATALOG.FACEBOOK_PAGE.scopes.map((s) => s.scope);
    expect(scopes).toContain("pages_read_user_content");
    expect(scopes).toContain("pages_manage_engagement");
  });
});

describe("чего не хватает", () => {
  it("называет только недостающие права и для чего они", () => {
    const missing = missingScopes("YOUTUBE", ["https://www.googleapis.com/auth/youtube.upload"]);
    expect(missing.map((m) => m.scope)).toEqual([
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ]);
    const text = describeMissingScopes("YOUTUBE", missing);
    // Короткое имя без адреса Google — это читает владелец.
    expect(text).toContain("youtube.force-ssl (");
    expect(text).not.toContain("googleapis.com");
  });

  it("все права на месте — пусто", () => {
    const all = TOKEN_SCOPE_CATALOG.WHATSAPP.scopes.map((s) => s.scope);
    expect(missingScopes("WHATSAPP", [...all, "business_management"])).toEqual([]);
  });

  it("права из ответа OAuth: Google через пробел, TikTok через запятую", () => {
    expect(splitScopes("a b  c")).toEqual(["a", "b", "c"]);
    expect(splitScopes("user.info.basic,video.upload")).toEqual(["user.info.basic", "video.upload"]);
    expect(splitScopes(undefined)).toEqual([]);
  });
});

describe("отказ по правам отличается от прочих отказов", () => {
  it("код 10 и 200-299 — прав нет", () => {
    expect(classifyGraphDenial(400, { error: { code: 10, message: "x" } })).toBe("missing");
    expect(classifyGraphDenial(403, { error: { code: 200, message: "x" } })).toBe("missing");
  });

  it("мёртвый маркер (190) — не «прав нет», это ловит другая проверка", () => {
    expect(classifyGraphDenial(400, { error: { code: 190, message: "Error validating access token: permission" } })).toBe(
      "unknown"
    );
  });

  it("сеть и прочие сбои — «не узнали», а не «прав нет»", () => {
    expect(classifyGraphDenial(500, { error: { code: 2, message: "Service temporarily unavailable" } })).toBe("unknown");
    expect(classifyGraphDenial(200, {})).toBe("granted");
  });
});

describe("что выдано на самом деле", () => {
  it("Facebook: права и срок из debug_token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/debug_token?input_token=page-tok");
      return jsonResponse(200, {
        data: { is_valid: true, expires_at: 0, scopes: ["pages_show_list", "pages_messaging"] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await metaTokenInfo("page-tok");
    expect(info).not.toBeNull();
    // expires_at = 0 — бессрочный маркер.
    expect(info!.expiresAt).toBeNull();
    const missing = missingScopes("FACEBOOK_PAGE", info!.scopes).map((m) => m.scope);
    expect(missing).toContain("pages_manage_engagement");
    expect(missing).not.toContain("pages_messaging");
  });

  it("Facebook: маркер недействителен — «не узнали», а не пустой список прав", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { data: { is_valid: false } })));
    expect(await metaTokenInfo("dead-tok")).toBeNull();
  });

  it("Instagram: по отказу на каждом чтении видно, какого права нет", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/content_publishing_limit")) return jsonResponse(200, { data: [] });
      if (url.includes("/insights")) return jsonResponse(400, { error: { code: 10, message: "Application does not have permission" } });
      if (url.includes("/conversations")) return jsonResponse(200, { data: [] });
      if (url.includes("/media?")) return jsonResponse(200, { data: [{ id: "m1" }] });
      if (url.includes("/m1/comments")) return jsonResponse(403, { error: { code: 200, message: "Permissions error" } });
      if (url.includes("/me?")) return jsonResponse(200, { user_id: "1", username: "royal.home.tj" });
      throw new Error(`неожиданный URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const probes = await instagramLoginScopeProbes("ig-tok");
    expect(probes).toEqual({
      instagram_business_basic: "granted",
      instagram_business_content_publish: "granted",
      instagram_business_manage_insights: "missing",
      instagram_business_manage_messages: "granted",
      instagram_business_manage_comments: "missing",
    });
  });

  it("Instagram без единой публикации — право на комментарии «не проверено», а не «нет»", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/media?") ? jsonResponse(200, { data: [] }) : jsonResponse(200, {})))
    );
    const probes = await instagramLoginScopeProbes("ig-tok");
    expect(probes.instagram_business_manage_comments).toBe("unknown");
  });
});
