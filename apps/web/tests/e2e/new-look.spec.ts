import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» (облик royal) — сторож вёрстки и закрытости по умолчанию.
 *
 * Правило сервера (кому отдавать `look: "royal"`) проверяют тесты API
 * (apps/api/tests/ui-look-royal.test.ts). Здесь ответ /ui-shell подменяется,
 * чтобы проверить сам экран: на девяти ширинах нет горизонтальной прокрутки, а
 * без признака атрибута и нового экрана нет вовсе.
 */
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test("новый вид: главная без горизонтальной прокрутки на всех ширинах @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  await expect(page.locator(".ry-today")).toBeVisible();
  for (const width of WIDTHS) {
    // Шапка, полоса плиток и блоки не шире окна и не обрезаны краем рамки оболочки,
    // которая прокручивается сама и прячет вылет от scrollWidth (helpers/noOverflow.ts).
    await expectNoOverflowAt(page, width, ".clean-header, .ry-strip, .ry-strip > *, .ry-blocks, .ry-blocks > *");
  }
});

test("без признака с сервера новый вид не включается, даже по адресу ?look=royal", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/?look=royal");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator(".ry-today")).toHaveCount(0);
});

test("личный выход ?look=legacy снимает вид и запоминается", async ({ page }) => {
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/?look=legacy");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await page.goto("/");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await page.goto("/?look=royal");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
});
