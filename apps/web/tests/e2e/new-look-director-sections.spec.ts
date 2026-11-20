import { test, expect, type Page, type Route } from "@playwright/test";
import { expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * РАЗДЕЛЫ ДИРЕКТОРА В НОВОМ ВИДЕ (пачка E, 20.11.2026): «Отчёты», «Реклама»,
 * «Деньги», «Контроль руководителя» на телефоне (390) и компьютере (1440).
 *
 * Что сторожится:
 *  - воронка «Отчётов» — без процентов больше 100 и без оговорки про «больше 100 %»;
 *    в кольце источников склонения («2 заявки»), одна строка вкладок;
 *  - «Реклама» без кабинета — одна строка «не подключена» вместо нулевых плиток;
 *    с кабинетом — цена заявки, цена сделки и окупаемость (данные подменены: на
 *    стенде рекламы нет);
 *  - «Деньги» — доход, расходы и прибыль рядом над «Расходами», второстепенное в «⋯»;
 *  - «Контроль руководителя» — нули серые, пустые срезы одной строкой «Всё спокойно»;
 *  - ни на одной ширине нет горизонтальной прокрутки, ничего не вылезает за край.
 * Ответ /ui-shell подменяется (как в остальных new-look-*.spec.ts).
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });

async function look(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

const leadStats = (leads: number, deals: number, commissionTjs: number, spend: number) => ({
  leads, showings: Math.min(leads, deals + 3), deals, commissionTjs, costPerLeadTjs: leads ? spend / leads : null, costPerShowingTjs: null, costPerLeadMeta: null,
  romi: spend ? (commissionTjs - spend) / spend : null,
});
const board = (enabled: boolean, spend: number, lead: number, deals: number, commission: number) => ({
  from: ago(43_200).slice(0, 10), to: ago(0).slice(0, 10), label: "последние 30 дней", syncedAt: enabled ? ago(12) : null, enabled, refreshing: false, rows: [],
  totals: { leadStats: enabled ? leadStats(lead, deals, commission, spend) : null, periodTjs: spend, lifetimeTjs: spend * 3, running: 0, stalled: 0, stopped: 0,
    total: 0, linked: 0, foreign: 0, brandTjs: 0, brandCount: 0, pending: 0, conversations: lead * 2 },
});

const SIZES = [390, 1440];
const STRIPS = ".seg-ai, .hscroll, .tbl-wrap, .rh-filters-scroll, .clean-section-switcher, .cef-main-tabs";

for (const width of SIZES) {
  test(`отчёты на ${width}: воронка без «больше 100 %», склонения, одна строка вкладок @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(120_000);
    await look(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/reports");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
    const funnel = page.locator("#funnel-section");
    await expect(funnel.locator(".bars, .prog-legend, .empty").first()).toBeVisible({ timeout: 30_000 });
    const text = (await funnel.innerText()).replace(/ /g, " ");
    expect(text).not.toContain("больше 100");
    for (const m of text.matchAll(/(\d+) %/g)) expect(Number(m[1]), `процент в воронке: ${m[0]}`).toBeLessThanOrEqual(100);
    // в «Откуда приходят» — «N заявка/заявки/заявок», не «2 лидов»
    const sources = (await page.locator("#sources-report-section").innerText()).replace(/ /g, " ");
    expect(sources).not.toMatch(/\d лидов/);
    await expect(page.locator('[aria-label="Разделы отчётов"]')).toHaveCount(0);
    await expect(page.locator("#demand-supply-fold > summary")).toBeVisible();
    await expectNoOverflowAt(page, width, ".pg-h, .tiles .tile, .card, .sec-h", { strips: STRIPS });
  });

  test(`реклама на ${width}: не подключена — одна строка; подключена — цена заявки и окупаемость @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(120_000);
    await look(page);
    await page.setViewportSize({ width, height: 900 });
    await page.route((u) => u.pathname === "/api/v1/ads/board" && !u.searchParams.has("from"), json(board(false, 0, 0, 0, 0)));
    await page.goto("/ads");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
    await expect(page.getByText("Реклама не подключена, поэтому цифр по ней нет.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".tiles .tile")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Подключить" })).toHaveAttribute("href", "/settings?tab=channels");
    await expectNoOverflowAt(page, width, ".pg-h, .card, .quiet", { strips: STRIPS });

    await page.unroute((u) => u.pathname === "/api/v1/ads/board" && !u.searchParams.has("from"));
    // текущий период: 3 000 с., 30 заявок, 2 сделки, 9 000 с. комиссии; прошлый — 2 000 с. и 25 заявок
    await page.route((u) => u.pathname === "/api/v1/ads/board", (route) => {
      const prev = new URL(route.request().url()).searchParams.has("from");
      return route.fulfill({ json: prev ? board(true, 2000, 25, 1, 0) : board(true, 3000, 30, 2, 9000) });
    });
    await page.goto("/ads");
    const tiles = page.locator(".ry-ads-tiles");
    await expect(tiles).toBeVisible({ timeout: 30_000 });
    const t = (await tiles.innerText()).replace(/[  ]/g, " ");
    expect(t).toContain("Цена заявки");
    expect(t).toContain("100,00 с.");
    expect(t).toContain("Цена сделки");
    expect(t).toContain("1 500,00 с.");
    expect(t).toContain("+200 %");
    // сравнение с прошлыми 30 днями: расход вырос на 50 %
    await expect(tiles.locator(".chip.delta").first()).toBeVisible();
    await expectNoOverflowAt(page, width, ".pg-h, .tiles .tile, .card, .quiet", { strips: STRIPS });
  });

  test(`деньги на ${width}: доход, расходы и прибыль рядом, второстепенное в «⋯» @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(120_000);
    await look(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/finance");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
    const strip = page.locator(".ry-money-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip).toContainText("Доход компании");
    await expect(strip).toContainText("Расходы");
    await expect(strip).toContainText(/Прибыль|Убыток/);
    await expect(page.locator(".cef-main-tabs [role=tab]")).toHaveText(["Расходы", "Обзор и прогноз", "Выплаты", "Учредители"]);
    // «⋯» открывает меню, в нём — подписки, календарь и таблица
    await page.locator(".cef-tool-disclosure > summary").click();
    await expect(page.getByRole("button", { name: "Календарь" })).toBeVisible();
    await page.getByRole("button", { name: "Календарь" }).click();
    await expect(page.locator(".cef-main-tabs [role=tab][aria-selected=true]")).toHaveText("Календарь");
    await page.goto("/finance");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expectNoOverflowAt(page, width, ".cef-toolbar, .ry-money-strip-cell, .cef-card", { strips: STRIPS });
  });

  test(`контроль руководителя на ${width}: нули серые, пустые срезы одной строкой @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(120_000);
    await look(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/oversight");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
    await expect(page.locator(".ry-control .tiles .tile").first()).toBeVisible({ timeout: 30_000 });
    // на стенде почти всё по нулям: нулевые плитки серые, а пустые срезы — одной строкой
    await expect(page.locator(".ry-control .tile.ry-tile-calm").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".ry-calm-line")).toContainText("Всё спокойно");
    const calmBg = await page.locator(".ry-control .tile.ry-tile-calm").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const cardBg = await page.locator(".ry-control .card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(calmBg, "серая подложка нулевой плитки отличается от карточки").not.toBe(cardBg);
    const body = await page.locator(".ry-control").innerText();
    for (const jargon of ["скоринг", "Вечные переговоры", "Тишина после показа", "Это не уведомления"]) expect(body).not.toContain(jargon);
    await expectNoOverflowAt(page, width, ".ry-control .pg-h, .ry-control .tile, .ry-control .card, .ry-control .quiet", { strips: STRIPS });
  });
}

test("ошибка загрузки — сообщение и «Повторить», а не вечная заглушка (отчёты и контроль)", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(120_000);
  await look(page);
  await page.route((u) => u.pathname === "/api/v1/reports/funnel", (r) => r.fulfill({ status: 500, json: { error: "Сбой" } }));
  await page.goto("/reports");
  await expect(page.locator("#funnel-section").getByRole("button", { name: "Повторить" })).toBeVisible({ timeout: 30_000 });
  await page.route((u) => u.pathname === "/api/v1/oversight/summary", (r) => r.fulfill({ status: 500, json: { error: "Сбой" } }));
  await page.goto("/oversight");
  await expect(page.getByRole("button", { name: "Повторить" }).first()).toBeVisible({ timeout: 30_000 });
  // сводки нет — «всё спокойно» не рисуется: сбой не выглядит спокойствием
  await expect(page.locator(".ry-calm-line")).toHaveCount(0);
});
