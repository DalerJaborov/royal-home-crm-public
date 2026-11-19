import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — пачка records (20.11.2026): «Архив и корзина», «Подбор сотрудников»,
 * анкета кандидата, вход и две страницы по ссылке для клиентов (объект, отчёт владельцу).
 *
 * 1) На девяти ширинах ни один экран не даёт горизонтальной прокрутки и ничего не
 *    вылезает за край карточки.
 * 2) Страницы без входа: новый вид ТОЛЬКО по `?look=royal` (или выбору сотрудника,
 *    запомненному на устройстве). Без него — ни атрибута, ни метки, и страница не
 *    делает ни одного запроса сверх прежних.
 * Данные публичных страниц вымышленные (ни одного реального клиента).
 */
async function stubShell(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

const SHARE = {
  property: {
    title: "3-комн · Сино, у парка, длинное название объекта для проверки переноса", type: "APARTMENT", rooms: 3, areaSqm: "86",
    price: "785000", currency: "TJS", district: "Сино", city: "Душанбе", condition: "EXCELLENT",
    amenities: ["Лифт", "Парковка", "Мебель", "Кондиционер"], description: "Светлая квартира, окна на две стороны.",
    photos: [], clipVideoUrl: null, sold: false, saleStatus: "AVAILABLE",
  },
  agent: { fullName: "Сотрудник Один", phone: "+992900000002" },
};
const REPORT = {
  generatedAt: "2026-11-20T06:30:00.000Z",
  agency: { name: "Royal Home", slogan: "Агентство недвижимости", logoUrl: null },
  property: { title: "3-комн · Сино", rooms: 3, district: "Сино", city: "Душанбе", price: 785000, currency: "TJS", photoUrl: null, saleStatus: "AVAILABLE", daysOnSale: 23 },
  periods: {
    week: { shownToClients: 9, contacts: 4, showings: 2, comments: 3, siteViews: 61, ads: { impressions: 1840, inquiries: 3 } },
    all: { shownToClients: 34, contacts: 15, showings: 6, comments: 11, siteViews: 412, ads: { impressions: 9120, inquiries: 12 } },
  },
  weekly: [{ weekStart: "2026-11-02", events: 12, people: 6 }, { weekStart: "2026-11-09", events: 8, people: 4 }, { weekStart: "2026-11-16", events: 6, people: 3 }],
  topics: [{ key: "PRICE", label: "Цена", count: 7 }, { key: "BARGAIN", label: "Торг и скидка", count: 5 }],
  nextStep: { kind: "PRICE", title: "Обсудить цену", text: "Чаще всего спрашивают про торг.", evidence: ["7 вопросов о цене"] },
};
async function stubPublic(page: Page) {
  await page.route((u) => u.pathname === "/api/v1/l/e2e-token", (r) => r.fulfill({ json: SHARE }));
  await page.route((u) => u.pathname === "/api/v1/public/owner-report/e2e-token", (r) => r.fulfill({ json: REPORT }));
}

const STAFF = [
  { url: "/archive", ready: ".ry-archive .bins > button", check: ".ry-archive .pg-h, .ry-archive .card, .ry-archive .bins > button, .ry-archive .trio > .n, .ry-archive .list > .row, .ry-archive .pill, .ry-archive .seg-ai > a" },
  { url: "/vacancies", ready: "[data-ry-section=\"records\"] #vacancies-list", check: "[data-ry-section=\"records\"] .card, [data-ry-section=\"records\"] .clean-candidate-row, [data-ry-section=\"records\"] .seg > button, [data-ry-section=\"records\"] .pill" },
];

for (const screen of STAFF) {
  test(`новый вид ${screen.url}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await stubShell(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(screen.url);
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
      await expectNoOverflowAt(page, width, screen.check, { strips: "", textRoot: "[data-ry-section=\"records\"]" });
    }
  });
}

test("новый вид: анкета кандидата без горизонтальной прокрутки на всех ширинах", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(240_000);
  await stubShell(page, true);
  await page.goto("/vacancies?stage=ALL");
  const first = page.locator(".clean-candidate-row a[href^=\"/vacancies/\"]").first();
  const found = await first.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  test.skip(!found, "на стенде нет ни одной анкеты");
  const href = await first.getAttribute("href");
  for (const width of LOOK_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(href!);
    await expect(page.locator(".rh2[data-ry-section=\"records\"].clean-client-detail").first()).toBeVisible({ timeout: 30_000 });
    await expectNoOverflowAt(page, width, "[data-ry-section=\"records\"] .card, [data-ry-section=\"records\"] .pill, [data-ry-section=\"records\"] .chip", { strips: ".clean-record-tabs", textRoot: "[data-ry-section=\"records\"]" });
  }
});

test("без признака метки раздела нет — прежний вид Архива и Подбора цел", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(120_000);
  await stubShell(page, false);
  for (const screen of STAFF) {
    await page.goto(screen.url);
    await expect(page.locator(".rh2.screens .scr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    expect(await page.locator("[data-ry-section], .ry-archive").count(), screen.url).toBe(0);
  }
});

test.describe("страницы без входа", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const PUBLIC = [
    { url: "/login", ready: ".lgn-card" },
    { url: "/l/e2e-token", ready: ".pg-h h1" },
    { url: "/o/e2e-token", ready: ".or-title" },
  ];

  for (const screen of PUBLIC) {
    test(`${screen.url}: без ?look=royal — прежний вид и ни одного нового запроса`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
      await stubPublic(page);
      const api: string[] = [];
      page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) api.push(u.pathname); });
      await page.goto(screen.url);
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
      expect(await page.locator("[data-ry-section], .ry-login, .ry-public").count()).toBe(0);
      const withLook: string[] = [];
      page.removeAllListeners("request");
      page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) withLook.push(u.pathname); });
      await page.goto(`${screen.url}?look=royal`);
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
      // Новый вид — только оформление: обращения к серверу те же, что у прежнего.
      expect([...new Set(withLook)].sort()).toEqual([...new Set(api)].sort());
    });

    test(`${screen.url}?look=royal: без горизонтальной прокрутки на всех ширинах`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
      test.setTimeout(180_000);
      await stubPublic(page);
      for (const width of LOOK_WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${screen.url}?look=royal`);
        await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
        await expectNoOverflowAt(page, width, "[data-ry-section=\"records\"] *", { strips: "" });
      }
    });
  }

  test("запомненный на устройстве выбор сотрудника включает новый вид входа; ?look=legacy его снимает", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
    await page.addInitScript(() => { try { localStorage.setItem("rh-look:e2e-staff", "royal"); } catch { /* приватный режим */ } });
    await page.goto("/login");
    await expect(page.locator(".ry-login .lgn-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    await page.goto("/login?look=legacy");
    await expect(page.locator(".lgn-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
  });

  test("выключенная «Получить код» в новом виде приглушена", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
    await page.goto("/login?look=royal");
    const go = page.locator(".ry-login .lgn-card button[type=\"submit\"]");
    await expect(go).toBeVisible({ timeout: 30_000 });
    expect(Number(await go.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    await go.evaluate((el) => (el as HTMLButtonElement).setAttribute("disabled", ""));
    expect(Number(await go.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThanOrEqual(0.5);
  });
});
