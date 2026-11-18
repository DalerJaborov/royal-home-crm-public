import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», раздел «Объекты» — сторож вёрстки каталога и карточки объекта.
 *
 * Как и new-look.spec.ts, ответ /ui-shell подменяется: правило сервера (кому
 * отдавать `look: "royal"`) проверяют тесты API. Здесь — сам экран: на девяти
 * ширинах нет горизонтальной прокрутки и ни один блок раздела не вылез за окно
 * или за край режущего предка (общий помощник helpers/noOverflow.ts), а без
 * признака нового вида разметки и метки раздела нет вовсе.
 */
/** Задуманные ленты с собственной прокруткой: вкладки, стадии, вкладки карточки, миниатюры, лента фото. */
const STRIPS = ".seg-ai, .hscroll, .rh-tabs-scroll, .ry-gal-thumbs, .rh-gallery-track";

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test("новый вид: каталог и карточка объекта без горизонтальной прокрутки @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/properties");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  await expect(page.locator('.ry-objects-page[data-ry-section="objects"]')).toBeVisible();
  await expect(page.locator(".ry-obj-card").first()).toBeVisible();
  for (const width of LOOK_WIDTHS) {
    await expectNoOverflowAt(page, width, ".ry-objects-head, .ry-obj-grid, .ry-obj-card, .ry-obj-card button, .clean-catalog-toolbar > *", { strips: STRIPS });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".ry-obj-card .ry-obj-link").first().click();
  await expect(page.locator('.ry-object-page[data-ry-section="objects"]')).toBeVisible();
  await expect(page.locator(".ry-obj-summary")).toBeVisible();
  for (const width of LOOK_WIDTHS) {
    await expectNoOverflowAt(page, width, ".ry-obj-summary, .ry-obj-facts, .ry-obj-actions > *, .rh-gallery, .rh-pcard-tabs", { strips: STRIPS });
  }
});

test("без признака раздел «Объекты» остаётся прежним", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/properties?look=royal");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("[data-property-row]").first()).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator(".ry-objects-page, .ry-obj-card, [data-ry-section]")).toHaveCount(0);
});
