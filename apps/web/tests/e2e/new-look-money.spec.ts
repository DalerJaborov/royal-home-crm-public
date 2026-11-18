import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», раздел «Деньги» (пачка money) — сторож вёрстки семи вкладок.
 *
 * Ответ /ui-shell подменяется, как в new-look-objects.spec.ts: правило сервера
 * (кому отдавать `look: "royal"`) проверяют тесты API. Здесь — экран: на девяти
 * ширинах ни одна вкладка «Денег» не даёт горизонтальной прокрутки и ни один
 * блок раздела не вылез за окно или за край режущего предка
 * (helpers/noOverflow.ts); без признака нового вида метки раздела нет вовсе.
 * Широкие таблицы («Таблица», «Выплаты») листаются внутри своей рамки — это
 * задуманные ленты, как и ряд вкладок.
 */
const STRIPS = ".cef-main-tabs, .cef-table-scroll, .tbl-wrap, .hscroll, .cef-sub-presets, .chart.wide";
const TABS = ["expenses", "recurring", "calendar", "table", "overview", "payouts", "founders"] as const;
const BLOCKS = [
  ".cef-toolbar", ".cef-tools", ".cef-card", ".cef-row", ".cef-legend", ".ry-donut", ".ry-money-tiles > *",
  ".cef-sub-row", ".cef-subscription-detail", ".cef-calendar-grid", ".cef-table-kpis", ".cef-table-filters",
  ".cef-overview .sec", ".cef-founder-cards", ".cef-founder-list",
].join(", ");

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test("новый вид: все вкладки «Денег» без горизонтальной прокрутки @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(300_000); // 7 вкладок × 9 ширин
  await withShell(page, { enabled: true, look: "royal" });
  for (const tab of TABS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/finance?workspace=${tab}`);
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator('.finance-clean[data-ry-section="money"]')).toBeVisible();
    await expect(page.locator(`#finance-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    for (const width of LOOK_WIDTHS) await expectNoOverflowAt(page, width, BLOCKS, { strips: STRIPS });
  }
});

/**
 * Текст, почти слившийся с фоном (контраст ниже 3:1): белое на белом, тёмное на
 * тёмном. Так уже было при переносе — итог «Всего» учредителей стал белым на
 * белой карточке из-за веса правил, и сумма исчезла с экрана без единой ошибки.
 * Фон — первый непрозрачный предок; подсказка графика и скрытое для чтеца не в счёт.
 */
async function lowContrastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (c: string) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null) => {
      for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0.5) return c; }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const bad: string[] = [];
    for (const el of document.querySelectorAll('[data-ry-section="money"] *')) {
      if (!(el instanceof HTMLElement) || el.closest(".tipbox, .sr-only, svg")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
      const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      if ((l1 + 0.05) / (l2 + 0.05) < 3) bad.push(`${el.className || el.tagName}: «${el.textContent!.trim().slice(0, 30)}»`);
    }
    return bad;
  });
}

test("новый вид: текст «Денег» не сливается с фоном — светлая и тёмная тема", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(240_000); // 7 вкладок × 2 темы
  await withShell(page, { enabled: true, look: "royal" });
  for (const theme of ["light", "dark"]) {
    for (const tab of TABS) {
      await page.goto(`/finance?workspace=${tab}`);
      await expect(page.locator('.finance-clean[data-ry-section="money"]')).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      if (theme === "dark") await page.evaluate(() => { document.documentElement.dataset.theme = "royal-home-2026-night"; });
      expect(await lowContrastTexts(page), `${theme} · ${tab}`).toEqual([]);
    }
  }
});

test("новый вид: окно расхода помечено разделом и не вылезает за экран", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/finance");
  await page.locator(".cef-add").click();
  await expect(page.locator('.cef-sheet-backdrop[data-ry-section="money"] .cef-sheet')).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await expectNoOverflowAt(page, width, ".cef-sheet, .cef-sheet .cef-tiles, .cef-sheet-footer > *", { strips: STRIPS });
  }
});

test("без признака раздел «Деньги» остаётся прежним", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/finance?look=royal&workspace=overview");
  await expect(page.locator(".cef-page")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator("[data-ry-section], .ry-money-tiles, .ry-donut")).toHaveCount(0);
});
