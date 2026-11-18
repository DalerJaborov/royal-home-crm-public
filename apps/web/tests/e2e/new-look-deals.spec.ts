import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», раздел «Сделки» — сторож вёрстки доски, сводки и строк.
 *
 * Как и new-look-objects.spec.ts, ответ /ui-shell подменяется: правило сервера
 * (кому отдавать `look: "royal"`) проверяют тесты API. Здесь — сам экран: на
 * девяти ширинах нет горизонтальной прокрутки и ни один блок раздела не вылез
 * за окно или за край режущего предка (общий помощник helpers/noOverflow.ts), а
 * без признака нового вида нет ни разметки, ни метки раздела.
 */
/** Задуманная лента с собственной прокруткой — этапы доски на телефоне. */
const STRIPS = ".ry-deals-stages";
const PARTS = ".ry-deals-head, .ry-deals-head-acts > *, .ry-deals-tiles > *, .ry-deal-row, .ry-deal-row-acts > *, .ry-deal-tile, .ry-deal-tile button, .ry-deal-col";

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test("новый вид: доска сделок без горизонтальной прокрутки @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/deals");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  await expect(page.locator('.ry-deals-page[data-ry-section="deals"]')).toBeVisible();
  await expect(page.locator(".ry-deals-tiles")).toBeVisible();
  for (const width of LOOK_WIDTHS) {
    await expectNoOverflowAt(page, width, PARTS, { strips: STRIPS });
  }
});

test("без признака раздел «Сделки» остаётся прежним", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/deals?look=royal");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("h1", { hasText: "Сделки" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator(".ry-deals-page, .ry-deal-tile, [data-ry-section]")).toHaveCount(0);
});
