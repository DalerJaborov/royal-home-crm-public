import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — «Отчёты», «Источники лидов», «Инсайты от ИИ», «Воронка» и
 * «Подготовка объектов» (пачка analytics, 19.11.2026): сторож вёрстки.
 *
 * Выпуски инсайтов и кампании воронки подменяются (в сиде стенда их нет): на
 * девяти ширинах экраны не дают горизонтальной прокрутки и ничего не вылезает за
 * край карточки, длинные названия переносятся, а не режутся. Без признака с
 * сервера метки раздела нет.
 */
const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
const LONG = "Очень длинное название кампании для проверки переноса строки в карточке воронки";
const campaign = (id: string, name: string, enabled: boolean) => ({
  id, name, enabled, accountId: null, postUrl: null, mediaId: null, postUrls: [], mediaIds: [], requireFollowAll: false, deliverOnSecondClaim: false,
  keywords: ["ЧЕКЛИСТ"], anyComment: false, publicReplies: ["Отправили"], inviteText: "Привет", inviteButton: "Получить", requireFollow: true,
  followText: "Подпишитесь", followButton: "Готово", notFollowingText: "Нет", maxFollowChecks: 3, deliverIfUnsure: true, deliveredText: "Держите",
  filePath: "x.pdf", fileName: "чек-лист.pdf", fileSize: 1000, link: null, handoffToBot: true, createdAt: ago(10), updatedAt: ago(1), fileUrl: null,
  stats: { invited: 148, awaitingFollow: 12, delivered: 121, failed: 3, leads: 27 },
});
const deliveries = [
  { id: "d1", campaignId: "lm1", campaignName: LONG, igUserId: "1", username: "very_long_instagram_username_for_wrap_check", commentText: `ЧЕКЛИСТ ${"пожалуйста ".repeat(8)}`,
    state: "FAILED", followChecks: 0, wasFollowing: null, deliveredAsFile: null, clientId: null, clientShortId: null, invitedAt: ago(0.1), deliveredAt: null, lastError: "Instagram не принял сообщение: окно 24 часа закрыто" },
];
const digests = [
  { id: "g1", periodStart: ago(15), periodEnd: ago(1), meetingAt: ago(-1), status: "PARTIAL", coverage: { calls: 64, analyzed: 18, findings: 9, penalties: 2, error: "лимит разборов" }, createdAt: ago(1), caseCount: 1 },
];
const cases = [
  { id: "k1", agentId: "a1", agentName: "Сотрудник Один", clientId: "c1", clientName: LONG, clientShortId: 1, kind: "call_low_score", severity: 4, sourceKey: "s1", recordingUrl: null,
    timeline: { kind: "call_low_score", content: "Агент: Алло.\nКлиент: Сколько стоит?", meta: { score: 38, coaching: "Сначала спросите бюджет." } },
    verdict: { wrong: [{ quote: "Пятьсот сорок тысяч.", why: `Цена без вопроса о бюджете ${"и без показа ".repeat(5)}` }], better: ["Спросить бюджет"], summary: "Цена раньше потребности." },
    reviewedAt: null, reviewedById: null, meetingNote: null },
];

async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/lead-magnets", (r) => r.request().method() === "GET" ? r.fulfill({ json: [campaign("lm1", LONG, true), campaign("lm2", "Вторая", false)] }) : r.fallback());
  await page.route((u) => u.pathname === "/api/v1/lead-magnets/deliveries", (r) => r.fulfill({ json: { items: deliveries, total: 1, page: 1, pageSize: 20 } }));
  await page.route((u) => u.pathname === "/api/v1/insights", (r) => r.request().method() === "GET" ? r.fulfill({ json: digests }) : r.fallback());
  await page.route((u) => u.pathname === "/api/v1/insights/g1", (r) => r.fulfill({ json: cases }));
}

const CHECK = ".card, .tile, .sec-h, .pg-h, .bars .b, .donut, .tbl-wrap, .mag-card, .row, .quiet, .acc, .ry-obj-card";
const SCREENS = [
  { url: "/reports", ready: "#funnel-section .card" },
  { url: "/sources", ready: ".pg-h h1" },
  { url: "/insights", ready: ".sec-h h2" },
  { url: "/funnel", ready: ".mag-card" },
  { url: "/pipeline", ready: ".seg button" },
];

for (const screen of SCREENS) {
  test(`новый вид ${screen.url}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      // Каждая ширина — свой заход: на узком экране «Воронка» и «Инсайты» рисуют телефонный экран.
      await page.setViewportSize({ width, height: 900 });
      await page.goto(screen.url);
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
      await expect(page.locator('[data-ry-section="analytics"]').first()).toBeAttached({ timeout: 20_000 });
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 20_000 });
      await expectNoOverflowAt(page, width, CHECK, { strips: ".hscroll, .seg-ai, .tbl-wrap, .heat-wrap, .dsm-scroll" });
    }
  });
}

test("новый вид: названия в полосах и в кольце источников переносятся, а не режутся многоточием", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка в десктопном проекте");
  await stub(page, true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/reports");
  await expect(page.locator("#funnel-section .bars .b").first()).toBeVisible({ timeout: 20_000 });
  const cut = await page.locator('[data-ry-section="analytics"] :is(.bars .nm3, .donut .nm2, .row .t b, .row .t > span)').evaluateAll((els) =>
    els.filter((el) => { const s = getComputedStyle(el); return s.textOverflow === "ellipsis" || (s.whiteSpace === "nowrap" && el.scrollWidth > el.clientWidth + 1); })
      .map((el) => el.textContent?.slice(0, 40)));
  expect(cut).toEqual([]);
});

test("без признака с сервера метки раздела analytics нет ни на одном экране", async ({ page }) => {
  await stub(page, false);
  for (const url of ["/reports", "/sources", "/insights", "/funnel", "/pipeline"]) {
    await page.goto(url);
    await expect(page.locator("main#main")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pg-h h1, h1").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    await expect(page.locator("[data-ry-section]")).toHaveCount(0);
  }
});
