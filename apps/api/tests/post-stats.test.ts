import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { summarizePostStats, dushanbeHour, resetPostStatsCache, type PostStatsPost } from "../src/lib/postStats.js";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

/**
 * «Статистика роликов по всем площадкам» (24.09.2026) — GET /marketing/post-stats.
 *
 * Что проверяется:
 *  - чистые функции (summarizePostStats/dushanbeHour) без сети и без базы;
 *  - роут отдаёт контракт целиком, площадки — по фиксированному набору из пяти;
 *  - отказ ОДНОЙ площадки (здесь — YouTube, обмен refresh→access отклонён)
 *    не роняет ответ и не портит другую (Instagram остаётся available:true);
 *  - обычному агенту (не MARKETING/DIRECTOR/ADMIN) — 403, тем же способом,
 *    что apps/api/tests/property-publish-now.test.ts.
 */

function makePost(overrides: Partial<PostStatsPost>): PostStatsPost {
  return {
    propertyId: "p",
    shortId: 1,
    title: "тест",
    publishedAt: null,
    publishHour: null,
    stats: [],
    ...overrides,
  };
}

describe("dushanbeHour — чистая функция", () => {
  it("час Душанбе = час UTC + 5 по модулю 24", () => {
    expect(dushanbeHour(new Date("2026-09-24T19:00:00Z"))).toBe(0);
    expect(dushanbeHour(new Date("2026-09-24T10:00:00Z"))).toBe(15);
    expect(dushanbeHour(new Date("2026-09-24T20:30:00Z"))).toBe(1);
  });
});

describe("summarizePostStats — чистая функция", () => {
  it("суммы по площадке игнорируют null, а пост засчитывается только если хоть одно число прочиталось", () => {
    const posts: PostStatsPost[] = [
      makePost({ stats: [{ channel: "INSTAGRAM", views: 50, likes: null, comments: 2, url: null }] }),
      // Пост, у которого Instagram не прочитался вовсе (все null) — не должен
      // засчитаться как «пост с нулевыми просмотрами».
      makePost({ stats: [{ channel: "INSTAGRAM", views: null, likes: null, comments: null, url: null }] }),
    ];
    const { totals } = summarizePostStats(posts);
    expect(totals.INSTAGRAM).toEqual({ posts: 1, views: 50, likes: 0, comments: 2 });
    expect(totals.FACEBOOK).toEqual({ posts: 0, views: 0, likes: 0, comments: 0 });
  });

  it("byHour — среднее суммарных просмотров по ВСЕМ площадкам поста, только часы, где есть посты", () => {
    const posts: PostStatsPost[] = [
      makePost({ publishHour: 10, stats: [{ channel: "INSTAGRAM", views: 100, likes: null, comments: null, url: null }] }),
      makePost({
        publishHour: 10,
        stats: [
          { channel: "INSTAGRAM", views: 200, likes: null, comments: null, url: null },
          { channel: "YOUTUBE", views: 100, likes: null, comments: null, url: null },
        ],
      }),
      // Час неизвестен — не должен появиться в byHour отдельной строкой.
      makePost({ publishHour: null, stats: [{ channel: "INSTAGRAM", views: 999, likes: null, comments: null, url: null }] }),
    ];
    const { byHour } = summarizePostStats(posts);
    expect(byHour).toEqual([{ hour: 10, posts: 2, avgViews: 200 }]);
  });
});

describe("GET /api/v1/marketing/post-stats", () => {
  const runId = Date.now();
  const password = "testpass123";
  const mediaId = `ig-media-${runId}`;
  const ytVideoId = `yt-video-${runId}`;

  let districtId: string;
  let marketingToken: string;
  let plainAgentToken: string;
  let propertyId: string;
  let savedSettings: Record<string, unknown>;
  let disabledDefaultIgAccountId: string | null = null;

  const TOUCHED_SETTINGS = [
    "metaIgToken",
    "metaPageToken",
    "metaPageId",
    "youtubeClientId",
    "youtubeClientSecret",
    "youtubeRefreshToken",
  ] as const;

  async function login(phone: string) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  /** Подменяем сеть: Instagram (медиа + инсайты просмотров) отвечает как надо,
   *  обмен токена YouTube отклоняется — тем самым проверяем, что отказ ОДНОЙ
   *  площадки не портит другую. Всё остальное — по умолчанию 404, как в
   *  tests/instagram-online-followers.test.ts. */
  function stubNetwork() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes(`/${mediaId}?fields=`)) {
          return new Response(
            JSON.stringify({
              like_count: 120,
              comments_count: 7,
              permalink: "https://www.instagram.com/p/test-post/",
              timestamp: "2026-09-20T14:00:00+0000",
            }),
            { status: 200 }
          );
        }
        if (url.includes(`${mediaId}/insights`) && url.includes("ig_reels_avg_watch_time")) {
          // «Первые секунды»: удержание отдельным запросом — 6,5 с в среднем,
          // 42,5 % листают дальше (Instagram отдаёт проценты, не долю).
          return new Response(
            JSON.stringify({
              data: [
                { name: "ig_reels_avg_watch_time", values: [{ value: 6500 }] },
                { name: "reels_skip_rate", values: [{ value: 42.5 }] },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes(`${mediaId}/insights`)) {
          return new Response(JSON.stringify({ data: [{ values: [{ value: 4321 }] }] }), { status: 200 });
        }
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        return new Response("{}", { status: 404 });
      })
    );
  }

  beforeAll(async () => {
    const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    savedSettings = Object.fromEntries(TOUCHED_SETTINGS.map((k) => [k, (current as Record<string, unknown>)[k]]));
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        metaIgToken: `ig-token-${runId}`,
        youtubeClientId: `yt-client-${runId}`,
        youtubeClientSecret: `yt-secret-${runId}`,
        youtubeRefreshToken: `yt-refresh-${runId}`,
      },
    });

    // Аккаунт Instagram по умолчанию (messengers/meta.ts::loadDefaultInstagramAccountToken)
    // побеждает Settings.metaIgToken — отключаем его на время теста, чтобы
    // маркер, который проверяет ЭТОТ тест, точно использовался.
    const defaultIg = await prisma.messengerAccount.findFirst({
      where: { channel: "INSTAGRAM", isDefault: true, enabled: true },
    });
    if (defaultIg) {
      disabledDefaultIgAccountId = defaultIg.id;
      await prisma.messengerAccount.update({ where: { id: defaultIg.id }, data: { enabled: false } });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    districtId = (await prisma.district.create({ data: { name: `Тест-район-post-stats-${runId}` } })).id;
    const marketing = await prisma.agent.create({
      data: { fullName: "Маркетолог post-stats", phone: `+992978${runId}`, role: "MARKETING", passwordHash },
    });
    marketingToken = await login(marketing.phone);
    const plain = await prisma.agent.create({
      data: { fullName: "Обычный агент post-stats", phone: `+992979${runId}`, role: "AGENT", passwordHash },
    });
    plainAgentToken = await login(plain.phone);

    const property = await prisma.property.create({
      data: {
        title: `Ролик для статистики ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 45000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
        publishedChannels: ["INSTAGRAM", "YOUTUBE"],
        publishedPostIds: { INSTAGRAM: mediaId, YOUTUBE: ytVideoId },
        // Заведомо в будущем — гарантирует первое место в выборке «30 самых
        // свежих» (lib/postStats.ts::loadNewestPublishedProperties) независимо
        // от того, сколько других опубликованных карточек уже есть в общей базе
        // (тесты сервера идут в два процесса на одной базе — см. CLAUDE.md).
        // На саму статистику это не влияет: publishedAt в ответе строится из
        // timestamp Instagram, а не из этого поля (см. проверку ниже).
        scheduledPublishAt: new Date("2030-01-01T00:00:00Z"),
      },
    });
    propertyId = property.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPostStatsCache();
  });

  afterAll(async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
    if (disabledDefaultIgAccountId) {
      await prisma.messengerAccount.update({ where: { id: disabledDefaultIgAccountId }, data: { enabled: true } });
    }
    await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    await prisma.agent.deleteMany({ where: { phone: { in: [`+992978${runId}`, `+992979${runId}`] } } });
    await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("обычному агенту — 403, кабинет маркетинга не его", async () => {
    stubNetwork();
    const res = await request(app).get("/api/v1/marketing/post-stats").set("Authorization", `Bearer ${plainAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("отдаёт контракт целиком, и отказ YouTube не портит Instagram", async () => {
    stubNetwork();
    const res = await request(app).get("/api/v1/marketing/post-stats").set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.fetchedAt).toBe("string");
    expect(Array.isArray(res.body.platforms)).toBe(true);
    expect(Array.isArray(res.body.posts)).toBe(true);
    expect(Array.isArray(res.body.byHour)).toBe(true);

    // Пять площадок, фиксированный набор, каждая — с полным набором полей контракта.
    const channels = res.body.platforms.map((p: { channel: string }) => p.channel).sort();
    expect(channels).toEqual(["FACEBOOK", "INSTAGRAM", "TELEGRAM", "TIKTOK", "YOUTUBE"]);
    for (const platform of res.body.platforms) {
      expect(platform).toEqual(
        expect.objectContaining({
          channel: expect.any(String),
          connected: expect.any(Boolean),
          available: expect.any(Boolean),
          posts: expect.any(Number),
          views: expect.any(Number),
          likes: expect.any(Number),
          comments: expect.any(Number),
        })
      );
      expect(platform.reason === null || typeof platform.reason === "string").toBe(true);
    }

    // Instagram — площадка, которую мы подключили и подставили рабочий ответ:
    // должна быть доступна и её числа посчитаны.
    const instagram = res.body.platforms.find((p: { channel: string }) => p.channel === "INSTAGRAM");
    expect(instagram.connected).toBe(true);
    expect(instagram.available).toBe(true);
    expect(instagram.reason).toBeNull();
    expect(instagram.posts).toBe(1);
    expect(instagram.likes).toBe(120);
    expect(instagram.comments).toBe(7);
    expect(instagram.views).toBe(4321);

    // YouTube — подключён (ключи заданы), но обмен токена отклонён Google:
    // площадка обязана честно сказать «недоступна», а не тихо занулиться и не
    // уронить остальной ответ.
    const youtube = res.body.platforms.find((p: { channel: string }) => p.channel === "YOUTUBE");
    expect(youtube.connected).toBe(true);
    expect(youtube.available).toBe(false);
    expect(typeof youtube.reason).toBe("string");
    expect(youtube.posts).toBe(0);

    // Пост в списке — конкретно наш, с обеими площадками и разобранным временем.
    const post = res.body.posts.find((p: { propertyId: string }) => p.propertyId === propertyId);
    expect(post).toBeTruthy();
    expect(post.title).toBe(`Ролик для статистики ${runId}`);
    // publishedAt взят из timestamp Instagram (2026-09-20T14:00 UTC+0000 в ответе
    // Meta), а не из scheduledPublishAt (12:00Z) — живой момент публикации точнее.
    expect(post.publishedAt).toBe("2026-09-20T14:00:00.000Z");
    // 14:00 UTC + 5 = 19:00 по Душанбе.
    expect(post.publishHour).toBe(19);

    const igStat = post.stats.find((s: { channel: string }) => s.channel === "INSTAGRAM");
    expect(igStat).toEqual({
      channel: "INSTAGRAM",
      views: 4321,
      likes: 120,
      comments: 7,
      url: "https://www.instagram.com/p/test-post/",
      avgWatchSec: 6.5,
      skipRate: 0.425,
      watchedShare: null,
      note: null,
    });
    const ytStat = post.stats.find((s: { channel: string }) => s.channel === "YOUTUBE");
    // YouTube отказал — числа null, но пост и площадка INSTAGRAM рядом не пострадали.
    expect(ytStat).toEqual({
      channel: "YOUTUBE",
      views: null,
      likes: null,
      comments: null,
      url: null,
      avgWatchSec: null,
      skipRate: null,
      watchedShare: null,
      // Причина отказа по самому посту (12.10.2026): экран называет её вместо «площадка не отдала число».
      note: expect.any(String),
    });

    // Пост опубликован в 19:00 по Душанбе — этот час обязан появиться в byHour.
    const hourRow = res.body.byHour.find((h: { hour: number }) => h.hour === 19);
    expect(hourRow).toBeTruthy();
    expect(hourRow.posts).toBeGreaterThanOrEqual(1);
  });

  it("кэш на 30 минут отдаёт то же самое без второго похода в сеть, ?refresh=1 обходит его", async () => {
    stubNetwork();
    const first = await request(app).get("/api/v1/marketing/post-stats").set("Authorization", `Bearer ${marketingToken}`);
    expect(first.status).toBe(200);

    // Меняем сеть на заведомо другой ответ и снимаем кэш только через ?refresh=1.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 }))
    );

    const cached = await request(app).get("/api/v1/marketing/post-stats").set("Authorization", `Bearer ${marketingToken}`);
    expect(cached.body.fetchedAt).toBe(first.body.fetchedAt);

    const refreshed = await request(app)
      .get("/api/v1/marketing/post-stats?refresh=1")
      .set("Authorization", `Bearer ${marketingToken}`);
    expect(refreshed.body.fetchedAt).not.toBe(first.body.fetchedAt);
    const igAfterRefresh = refreshed.body.platforms.find((p: { channel: string }) => p.channel === "INSTAGRAM");
    // Сеть теперь всюду отвечает 404 — Instagram обязан честно перестать быть available.
    expect(igAfterRefresh.available).toBe(false);
  });
});
