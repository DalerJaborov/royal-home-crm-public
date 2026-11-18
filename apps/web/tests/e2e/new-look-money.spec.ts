import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», раздел «Деньги» (пачка money) — сторож вёрстки семи вкладок.
 *
 * Ответ /ui-shell подменяется, как в new-look-objects.spec.ts: правило сервера
 * (кому отдавать `look: "royal"`) проверяют тесты API. Здесь — экран: на девяти
 * ширинах ни одна вкладка «Денег» не даёт горизонтальной прокрутки и ни один
 * блок раздела не вылез за окно или за край режущего предка
 * (helpers/noOverflow.ts); крупные суммы не рвутся посреди числа; текст, значки
 * и подписи графиков держат контраст; без признака нового вида метки раздела нет.
 * Широкие таблицы («Таблица», «Выплаты») и длинный ряд месяцев графика листаются
 * внутри своей рамки — это задуманные ленты, как и ряд вкладок.
 */
const STRIPS = ".cef-main-tabs, .cef-table-scroll, .tbl-wrap, .hscroll, .cef-sub-presets, .rh2-bar-chart";
const TABS = ["expenses", "recurring", "calendar", "table", "overview", "payouts", "founders"] as const;
const BLOCKS = [
  ".cef-toolbar", ".cef-tools", ".cef-card", ".cef-row", ".cef-legend", ".ry-donut", ".ry-money-tiles > *",
  ".cef-sub-row", ".cef-subscription-detail", ".cef-calendar-grid", ".cef-table-kpis", ".cef-table-filters",
  ".cef-overview .sec", ".cef-founder-cards", ".cef-founder-list",
].join(", ");
/** Крупные суммы: число не должно рваться переносом, шрифт — не мельче 13 px. */
const BIG_SUMS = ".ry-amount-num, .cef-feed .cef-kpi, .cef-table-kpis strong, .cef-sub-summary strong, .cef-founder-card > strong";

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

/** Экран вкладки готов: панель видна и ничего в ней не «Загружаем…» (вместо слепого ожидания). */
async function openTab(page: Page, tab: string) {
  await page.goto(`/finance?workspace=${tab}`);
  await expect(page.locator('.finance-clean[data-ry-section="money"]')).toBeVisible();
  await expect(page.locator(`#finance-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  const panel = page.locator(`#finance-panel-${tab}`);
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText(/Загружаем|Считаем/, { timeout: 15_000 });
  await expect(panel.locator('.cef-skeleton, .cef-loading, [aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

/** Суммы, разорванные посреди числа (текст числа на двух строках) или ужатые мельче 13 px. */
async function brokenSums(page: Page): Promise<string[]> {
  return page.locator(BIG_SUMS).evaluateAll((els) => els.filter((el) => el.getClientRects().length).flatMap((el) => {
    const out: string[] = [];
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 13) out.push(`мельче 13 px (${size}): «${el.textContent}»`);
    if (el.classList.contains("ry-amount-num")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      if (lines > 1) out.push(`число разорвано: «${el.textContent}»`);
    }
    return out;
  }));
}

test("новый вид: все вкладки «Денег» без горизонтальной прокрутки, суммы не рвутся @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(400_000); // 7 вкладок × 9 ширин
  await withShell(page, { enabled: true, look: "royal" });
  for (const tab of TABS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTab(page, tab);
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    for (const width of LOOK_WIDTHS) {
      await expectNoOverflowAt(page, width, BLOCKS, { strips: STRIPS });
      expect(await brokenSums(page), `${tab} · ${width}px`).toEqual([]);
    }
  }
});

/**
 * Контраст по WCAG: текст — не ниже 4,5:1, крупный (от 24 px) и значки — не ниже 3:1.
 * Считаются и подписи в SVG графиков и кольца (`fill`), и подсказка графика (её
 * открываем наведением). Повод: при переносе итог «Всего» учредителей стал белым на
 * белой карточке из-за веса правил и исчез с экрана без единой ошибки.
 * Фон — первый непрозрачный предок; выключенное (приглушённое) и скрытое не в счёт.
 */
async function lowContrast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (c: string): Rgba => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = ({ r, g, b }: Rgba) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: Rgba, b: Rgba) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bgOf = (el: Element | null): Rgba => {
      for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0.5) return c; }
      return parse(getComputedStyle(document.body).backgroundColor);
    };
    const hidden = (el: Element) => {
      if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return true;
      if (el.closest('.sr-only, option, :disabled, [aria-disabled="true"], [hidden]')) return true;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.clipPath !== "none" || Number(st.opacity) < 0.6) return true;
      }
      return false;
    };
    const bad: string[] = [];
    const say = (el: Element, kind: string, r: number, need: number) =>
      bad.push(`${kind} ${r.toFixed(2)} < ${need}: ${(el.getAttribute("class") || el.tagName).slice(0, 40)} «${(el.textContent ?? "").trim().slice(0, 30)}»`);
    for (const el of document.querySelectorAll('[data-ry-section="money"] *')) {
      if (hidden(el)) continue;
      const st = getComputedStyle(el);
      if (el instanceof SVGTextElement) {
        const need = parseFloat(st.fontSize) >= 24 ? 3 : 4.5;
        const r = ratio(parse(st.fill), bgOf(el.closest("svg")));
        if (r < need) say(el, "текст SVG", r, need);
        continue;
      }
      if (el instanceof SVGSVGElement && !el.closest(".chart, .ry-donut") && el.getBoundingClientRect().width <= 40) {
        // Значки рисуются цветом текста (currentColor — у lucide атрибутом stroke, у значков вида — внутри);
        // свой цвет — только если он задан явно атрибутом.
        const own = el.getAttribute("stroke") ?? el.getAttribute("fill");
        const paint = !own || own === "currentColor" || own === "none" ? st.color : /^rgb/.test(st.stroke) ? st.stroke : st.fill;
        const r = ratio(parse(paint), bgOf(el.parentElement));
        if (r < 3) say(el, `значок ${paint} на ${getComputedStyle(el.parentElement!).backgroundColor} в ${el.parentElement?.className}`, r, 3);
        continue;
      }
      if (!(el instanceof HTMLElement)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      const need = parseFloat(st.fontSize) >= 24 ? 3 : 4.5;
      const r = ratio(parse(st.color), bgOf(el));
      if (r < need) say(el, "текст", r, need);
    }
    return bad;
  });
}

test("новый вид: контраст текста, значков и графиков «Денег» — светлая и тёмная тема", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(300_000); // 7 вкладок × 2 темы
  await withShell(page, { enabled: true, look: "royal" });
  for (const theme of ["light", "dark"]) {
    for (const tab of TABS) {
      await openTab(page, tab);
      if (theme === "dark") await page.evaluate(() => { document.documentElement.dataset.theme = "royal-home-2026-night"; });
      if (tab === "overview") {
        const hit = page.locator("#profit-chart-section .hit").last();
        if (await hit.count()) {
          await hit.scrollIntoViewIfNeeded();
          await hit.hover();
          await expect(page.locator("#profit-chart-section .tipbox")).toBeVisible();
        }
      }
      expect(await lowContrast(page), `${theme} · ${tab}`).toEqual([]);
    }
  }
});

test("новый вид: окно расхода помечено разделом и не вылезает за экран", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await openTab(page, "expenses");
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
