import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», раздел «Маркетинг» (пачка marketing, 19.11.2026) — сторож вёрстки.
 *
 * Ответ /ui-shell подменяется, как в остальных new-look-*.spec.ts: кому сервер даёт
 * `look: "royal"`, проверяют тесты API. Данные рекламы, роликов, комментариев,
 * изменений сайта и цен рынка тоже подменены (на стенде их нет): вымышленные, без
 * реальных клиентов. На девяти ширинах ни один экран раздела не даёт горизонтальной
 * прокрутки и ни один блок не вылез за окно или за край режущего предка; ряды вкладок,
 * лент статусов и широкие таблицы листаются внутри своей рамки — это задуманные ленты.
 * Без признака нового вида метки раздела нет (прежний вид цел).
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const LONG = "Участок 6 соток в Гиссаре — очень длинное название для проверки переноса строки на узком экране";
const spend = (spendTjs: number, conversations: number) => ({ spendTjs, spendOriginal: spendTjs / 10.9, impressions: conversations * 240, clicks: conversations * 6, conversations });
const leads = (n: number) => ({ leads: n, showings: n, deals: 0, commissionTjs: 0, costPerLeadTjs: n ? 84.6 : null, costPerShowingTjs: null, costPerLeadMeta: null, romi: null });
const adRow = (id: string, name: string, delivery: string, props: number) => ({
  id, name, campaignName: name, status: "ACTIVE", delivery, todayTjs: 86.4, objective: null, createdTime: ago(9000), startTime: ago(9000), stopTime: null,
  firstSpendAt: ago(9000), lastSpendAt: ago(40), activeDays: 11, postUrl: null, previewUrl: null, headline: name, brand: false,
  property: props ? { id: `p${id}`, shortId: 211, title: LONG, status: "ACTIVE", coverUrl: null } : null,
  properties: Array.from({ length: props }, (_, i) => ({ id: `p${id}${i}`, shortId: 211 + i, title: LONG, status: "ACTIVE", thumbUrl: null, share: 1 / props, spendTjs: 1840.5 / props, conversations: 9, leadStats: leads(4) })),
  assetCount: props || 1, needsReview: false, matchSource: "AUTO", period: spend(1_840_500.25, 23), lifetime: spend(4_210_000.75, 51), currency: "USD", leadStats: leads(23),
});
const board = {
  from: ago(43_200).slice(0, 10), to: ago(0).slice(0, 10), label: "последние 30 дней", syncedAt: ago(12), enabled: true, refreshing: false,
  rows: [adRow("a1", LONG, "RUNNING", 2), adRow("a2", "3-комнатная в Сино", "STALLED", 1), adRow("a3", "Новостройка", "REVIEW", 0)],
  totals: { leadStats: leads(38), periodTjs: 3_220_700.7, lifetimeTjs: 8311.35, running: 1, stalled: 1, stopped: 0, total: 3, linked: 2, foreign: 1, brandTjs: 0, brandCount: 0, pending: 1, conversations: 38 },
};
const result = (state: string) => ({ state, error: state === "FAILED" ? "Площадка отклонила ролик" : null, note: null, postId: null, url: null, retriable: true, attempts: 1, startedAt: ago(70), finishedAt: ago(65) });
const video = (id: string, status: string, channels: string[]) => ({
  id, mediaKind: "VIDEO", imagePaths: [], title: `${LONG} ${id}`, caption: LONG, brief: null, videoPath: "/uploads/none.mp4", originalName: "clip.mp4", sizeBytes: 48_200_000,
  durationSec: 38, width: 1080, height: 1920, hasAudio: true, videoCodec: "h264", coverMode: "AUTO", coverUrl: null, coverMeta: null, channels,
  destinations: channels.map((channel) => ({ channel, accountId: null })), status, scheduledAt: null, startedAt: ago(70), finishedAt: ago(65),
  results: Object.fromEntries(channels.map((c, i) => [c, result(i === 2 ? "FAILED" : "PUBLISHED")])), verdicts: [], createdAt: ago(1500), createdBy: { id: "x", name: "Маркетинг" }, duplicateOf: null,
});
const videos = [video("v1", "PARTIAL", ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS"]), video("v2", "DONE", ["INSTAGRAM"])];
const comment = (id: string, status: string) => ({ id, commentId: id, channel: "INSTAGRAM", mediaId: "m1", parentId: null, authorName: "very.long.instagram.author.name", text: LONG, status,
  note: "Бот не знает ответа", replyText: null, repliedAt: null, hiddenAt: null, dmText: null, dmSentAt: null, attempts: 1, createdAt: ago(37),
  post: { propertyId: "p1", propertyShortId: 211, propertyTitle: LONG, instagramUrl: "https://example.com/p/1" } });
const site = [
  { id: "s1", propertyId: "p1", action: "UPDATED", changes: { price: { from: 520000, to: 540000 }, title: { from: LONG, to: `${LONG} (новое)` } }, createdAt: ago(45), resolvedAt: null, resolution: null, property: { id: "p1", shortId: 211, title: LONG, publishedOnSite: true } },
  { id: "s2", propertyId: "p2", action: "CREATED", changes: null, createdAt: ago(200), resolvedAt: null, resolution: null, property: { id: "p2", shortId: 212, title: LONG, publishedOnSite: false } },
];
const segment = (districtName: string, rooms: number) => ({ key: `${districtName}${rooms}`, districtName, rooms, repair: "RENOVATED", count: 40, enough: true, medianPerSqmTjs: 6150,
  averagePerSqmTjs: 6270, medianPriceTjs: 1_480_000, averagePriceTjs: 1_495_000, freshestSeenAt: ago(90), newLast7Days: 9 });

async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  const json = (body: unknown) => (route: import("@playwright/test").Route) => route.fulfill({ json: body });
  await page.route((u) => u.pathname === "/api/v1/ads/board", json(board));
  await page.route((u) => u.pathname === "/api/v1/social-videos", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { items: videos, total: 2, counts: { DRAFT: 0, SCHEDULED: 0, PUBLISHING: 0, DONE: 1, PARTIAL: 1, FAILED: 0, REMOVED: 0 } } }) : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/social-videos/v1", (route) => route.request().method() === "GET" ? route.fulfill({ json: videos[0] }) : route.fallback());
  await page.route((u) => u.pathname.startsWith("/api/v1/uploads/"), (route) => route.fulfill({ status: 404, body: "" }));
  await page.route((u) => u.pathname === "/api/v1/instagram-comments", json({ items: [comment("k1", "ESCALATED"), comment("k2", "REPLIED")], total: 2, page: 1, pageSize: 20,
    counts: { all: 2, PENDING: 0, WORKING: 0, REPLIED: 1, HIDDEN: 0, DELETED: 0, ESCALATED: 1, SKIPPED: 0, FAILED: 0 } }));
  await page.route((u) => u.pathname === "/api/v1/site-notifications", json({ items: site, total: 2, page: 1, pageSize: 50 }));
  await page.route((u) => u.pathname === "/api/v1/market/segments", json({ minSample: 8, windowDays: 30, city: "Душанбе", sources: [{ source: "SOMON", count: 1240 }], truncated: false,
    segments: [segment("Исмоили Сомони", 4), segment("Сино", 2)] }));
}

const STRIPS = ".seg-ai, .hscroll, .tbl-wrap, .rh-filters-scroll, .clean-section-switcher";
const SCREENS = [
  { url: "/ads", ready: ".tiles .tile", check: ".pg-h, .tiles .tile, .card, .quiet, .list > .row" },
  { url: "/marketing", ready: ".tiles .tile", check: ".pg-h, .tiles .tile, .card, .quiet, .list > .row, .chip" },
  { url: "/marketing?tab=channels", ready: ".chn", check: ".pg-h, .card, .chn, .ry-mkt-brand, .quiet" },
  { url: "/social-videos", ready: ".list > .row", check: ".pg-h, .card, .list > .row, .chip" },
  { url: "/social-videos?open=v1", ready: ".pg-h h1", check: ".pg-h, .pg-h .acts, .card" },
  { url: "/social-videos?new=1", ready: ".pg-h h1", check: ".pg-h, .card" },
  { url: "/site-changes", ready: ".prow", check: ".pg-h, .card, .prow, .prow .diff > span" },
  { url: "/market", ready: ".card", check: ".pg-h, .card, .rh-filters" },
  { url: "/comments", ready: ".cmt", check: ".pg-h, .card, .cmt, .cmt .head, .cmt .aib-ask" },
];

for (const screen of SCREENS) {
  test(`новый вид ${screen.url}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // Корень окна (Rh2Portal) тоже несёт метку, но нулевой высоты — ждём шапку экрана.
      await page.goto(screen.url, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
      await expect(page.locator('.rh2.screens[data-ry-section="marketing"] .pg-h').first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(`[data-ry-section="marketing"] ${screen.ready}`).first()).toBeVisible({ timeout: 20_000 });
      await expectNoOverflowAt(page, width, `[data-ry-section="marketing"] :is(${screen.check})`, { strips: STRIPS });
    }
  });
}

test("новый вид: знаки соцсетей в родных цветах, текст строк не режется многоточием", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка одна на десктопном проекте");
  await stub(page, true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/marketing?tab=channels", { waitUntil: "domcontentloaded" });
  const youtube = page.locator('[data-ry-section="marketing"] .ry-mkt-brand[data-channel="YOUTUBE"]').first();
  await expect(youtube).toBeVisible({ timeout: 20_000 });
  expect(await youtube.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 0, 0)");
  await page.goto("/site-changes", { waitUntil: "domcontentloaded" });
  const rows = page.locator('[data-ry-section="marketing"] .prow .t :is(b, span, a)');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  for (const el of await rows.all()) {
    const cut = await el.evaluate((n) => n.scrollWidth > n.clientWidth + 1 || getComputedStyle(n).textOverflow === "ellipsis");
    expect(cut, await el.innerText()).toBe(false);
  }
});

test("без признака нового вида раздел «Маркетинг» прежний: метки и знаков нет", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка одна на десктопном проекте");
  test.setTimeout(120_000);
  await stub(page, false);
  for (const url of ["/ads", "/marketing?tab=channels", "/social-videos", "/site-changes", "/market", "/comments"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".rh2.screens .pg-h").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator("[data-ry-section]")).toHaveCount(0);
    await expect(page.locator(".ry-mkt-brand")).toHaveCount(0);
  }
});
