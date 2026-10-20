import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { loadPostStats, callAiText } = vi.hoisted(() => ({ loadPostStats: vi.fn(), callAiText: vi.fn() }));
vi.mock("../src/lib/postStats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/postStats.js")>()),
  loadPostStats,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { analyzePosts, POST_ANALYSIS_MIN_POSTS, _clearPostAnalysisCache } = await import("../src/lib/postAnalysis.js");
type AnalyzedPost = import("../src/lib/postAnalysis.js").AnalyzedPost;
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

/**
 * «ПОЧЕМУ ВЗЛЕТЕЛИ» (24.09.2026). Проверяется то, что ломается молча и выглядит
 * правдоподобно: вывод на горстке роликов, «лучшее» значение из одного ролика,
 * площадка, сравнённая не с той базой.
 */
function post(i: number, over: Partial<AnalyzedPost>): AnalyzedPost {
  return {
    propertyId: `p${i}`,
    shortId: i,
    title: `Объект ${i}`,
    views: 100,
    byChannel: { INSTAGRAM: 100 },
    publishHour: 10,
    publishDow: 1,
    type: "Квартира",
    district: "Сино",
    priceTjs: 400_000,
    rooms: 2,
    ...over,
  };
}

describe("Анализатор роликов", () => {
  it("меньше порога роликов — выводов нет, причина словами", () => {
    const r = analyzePosts([post(1, {}), post(2, {})]);
    expect(r.ready).toBe(false);
    expect(r.factors).toEqual([]);
    expect(r.reason).toContain(String(POST_ANALYSIS_MIN_POSTS));
  });

  it("вечер против утра: вечерние ролики набирают больше — это и есть лучший час выхода", () => {
    const posts = [
      post(1, { publishHour: 19, views: 400, byChannel: { INSTAGRAM: 400 } }),
      post(2, { publishHour: 20, views: 300, byChannel: { INSTAGRAM: 300 } }),
      post(3, { publishHour: 9, views: 100, byChannel: { INSTAGRAM: 100 } }),
      post(4, { publishHour: 10, views: 100, byChannel: { INSTAGRAM: 100 } }),
      post(5, { publishHour: 11, views: 100, byChannel: { INSTAGRAM: 100 } }),
      post(6, { publishHour: 10, views: 100, byChannel: { INSTAGRAM: 100 } }),
    ];
    const r = analyzePosts(posts);
    expect(r.ready).toBe(true);
    const hour = r.factors.find((f) => f.key === "hour")!;
    expect(hour.best).toContain("вечер");
    expect(hour.bestAvg).toBe(350);
    expect(hour.lift).toBeGreaterThan(0);
    expect(r.top[0].shortId).toBe(1);
  });

  it("значение с одним роликом «лучшим» не становится, даже если у него рекорд", () => {
    const posts = [
      post(1, { district: "Шохмансур", views: 5000, byChannel: { INSTAGRAM: 5000 } }),
      ...[2, 3, 4, 5, 6].map((i) => post(i, { district: i % 2 ? "Сино" : "Фирдавси", views: 100 + i })),
    ];
    const district = analyzePosts(posts).factors.find((f) => f.key === "district");
    expect(district?.best).not.toBe("Шохмансур");
  });

  it("признак, одинаковый у всех роликов, ничего не объясняет и не показывается", () => {
    const posts = [1, 2, 3, 4, 5, 6].map((i) => post(i, { views: i * 10, byChannel: { INSTAGRAM: i * 10 } }));
    const r = analyzePosts(posts);
    expect(r.factors.find((f) => f.key === "type")).toBeUndefined();
    expect(r.factors.find((f) => f.key === "district")).toBeUndefined();
  });

  it("площадка сравнивается по среднему ролику на ней, а не по сумме", () => {
    const posts = [1, 2, 3, 4, 5, 6].map((i) =>
      post(i, { byChannel: { INSTAGRAM: 300, YOUTUBE: 50, FACEBOOK: 100 }, views: 450 })
    );
    const ch = analyzePosts(posts).factors.find((f) => f.key === "channel")!;
    expect(ch.best).toBe("Instagram");
    expect(ch.bestAvg).toBe(300);
    expect(Math.round(ch.overallAvg)).toBe(150);
  });

  it("ролики без единой цифры просмотров в разбор не идут", () => {
    const posts = [1, 2, 3, 4, 5].map((i) => post(i, {})).concat([post(6, { byChannel: {}, views: 0 })]);
    expect(analyzePosts(posts).postsCounted).toBe(5);
  });
});

describe("GET /marketing/post-analysis", () => {
  const runId = Date.now();
  const password = "testpass123";
  let marketingToken: string;
  let agentToken: string;
  const phones = [`+992941${runId}`, `+992942${runId}`];

  async function login(phone: string) {
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.agent.create({ data: { fullName: "Маркетолог разбор", phone: phones[0], role: "MARKETING", passwordHash } });
    await prisma.agent.create({ data: { fullName: "Агент разбор", phone: phones[1], role: "AGENT", passwordHash } });
    marketingToken = await login(phones[0]);
    agentToken = await login(phones[1]);
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { phone: { in: phones } } });
  });

  const statsPost = (i: number, hour: number, views: number) => ({
    propertyId: `missing-${runId}-${i}`,
    shortId: i,
    title: `Объект ${i}`,
    publishedAt: new Date(Date.UTC(2026, 8, 20, hour - 5)).toISOString(),
    publishHour: hour,
    stats: [{ channel: "INSTAGRAM", views, likes: 1, comments: 0, url: null }],
  });

  it("сравнение и разбор ИИ приходят вместе; ИИ получает только готовые числа", async () => {
    _clearPostAnalysisCache();
    loadPostStats.mockResolvedValue({
      fetchedAt: new Date().toISOString(),
      platforms: [],
      byHour: [],
      posts: [statsPost(1, 19, 500), statsPost(2, 20, 400), statsPost(3, 10, 100), statsPost(4, 10, 100), statsPost(5, 11, 90), statsPost(6, 9, 80)],
    });
    callAiText.mockResolvedValue({ summary: "Вечерние ролики набирают больше." });

    const res = await request(app).get("/api/v1/marketing/post-analysis").set("Authorization", `Bearer ${marketingToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.factors.find((f: { key: string }) => f.key === "hour").best).toContain("вечер");
    expect(res.body.summary).toBe("Вечерние ролики набирают больше.");
    expect(callAiText).toHaveBeenCalledTimes(1);
  });

  it("ИИ упал — числа всё равно отдаются, разбор пуст", async () => {
    _clearPostAnalysisCache();
    callAiText.mockRejectedValueOnce(new Error("сеть"));
    const res = await request(app).get("/api/v1/marketing/post-analysis").set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.factors.length).toBeGreaterThan(0);
    expect(res.body.summary).toBeNull();
  });

  it("обычному агенту разбор не отдаётся", async () => {
    const res = await request(app).get("/api/v1/marketing/post-analysis").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });
});
