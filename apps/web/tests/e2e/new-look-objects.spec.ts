import { test, expect, type Page } from "@playwright/test";

/**
 * «НОВЫЙ ВИД», раздел «Объекты» — сторож вёрстки каталога и карточки объекта.
 *
 * Как и new-look.spec.ts, ответ /ui-shell подменяется: правило сервера (кому
 * отдавать `look: "royal"`) проверяют тесты API. Здесь — сам экран: на девяти
 * ширинах нет горизонтальной прокрутки и ни один блок раздела не шире окна, а
 * без признака нового разметки раздела нет вовсе.
 */
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

async function noSideScroll(page: Page, blocks: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: `горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
    const wide = await page.evaluate((sel) => [...document.querySelectorAll(sel)]
      .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
      .map((node) => `${node.className}`.slice(0, 60)), blocks);
    expect(wide, `блоки шире окна на ${width}px`).toEqual([]);
  }
}

test("новый вид: каталог и карточка объекта без горизонтальной прокрутки @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/properties");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  await expect(page.locator(".ry-objects-page")).toBeVisible();
  await expect(page.locator(".ry-obj-card").first()).toBeVisible();
  await noSideScroll(page, ".ry-objects-head, .ry-obj-grid, .ry-obj-card, .clean-catalog-toolbar, .seg-ai");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".ry-obj-card .ry-obj-link").first().click();
  await expect(page.locator(".ry-object-page")).toBeVisible();
  await expect(page.locator(".ry-obj-summary")).toBeVisible();
  await noSideScroll(page, ".ry-obj-summary, .ry-obj-facts, .ry-obj-actions, .rh-gallery, .ry-gal-thumbs, .rh-pcard-tabs");
});

test("без признака раздел «Объекты» остаётся прежним", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/properties?look=royal");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("[data-property-row]").first()).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator(".ry-objects-page, .ry-obj-card")).toHaveCount(0);
});
