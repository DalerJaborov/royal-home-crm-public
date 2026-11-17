import { test, expect, type Page } from "@playwright/test";

/**
 * «НОВЫЙ ВИД», пачка team: Команда, активность, Настройки (список и группа), «Ещё».
 *
 * Ответ /ui-shell подменяется, как в new-look.spec.ts. Проверяется вёрстка: на
 * девяти ширинах нет горизонтальной прокрутки, переключатели в настройках не
 * меньше 56×34, а без признака с сервера разметки нового вида нет вовсе.
 */
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
const SCREENS: { url: string; ready: string }[] = [
  { url: "/settings", ready: ".ry-set" },
  { url: "/settings?tab=bot&task=operation", ready: ".ry-set .ry-acc" },
  { url: "/settings?tab=system&task=workspace", ready: ".ry-set" },
  { url: "/team", ready: ".ry-teamp" },
  { url: "/activity", ready: ".ry-activity" },
  { url: "/more", ready: ".ry-more" },
];

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

async function noHorizontalScroll(page: Page, label: string) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: `${label}: горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
  }
}

for (const screen of SCREENS) {
  test(`новый вид team: ${screen.url} без горизонтальной прокрутки на всех ширинах`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    await withShell(page, { enabled: true, look: "royal" });
    await page.goto(screen.url);
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator(screen.ready).first()).toBeVisible();
    await noHorizontalScroll(page, screen.url);
  });
}

test("новый вид team: переключатели настроек не меньше 56×34", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка вёрстки в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/settings?tab=bot&task=operation");
  await page.locator(".ry-set .ry-acc .acc-h").first().click();
  const track = page.locator(".ry-set .tgl i").first();
  await expect(track).toBeVisible();
  const box = await track.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(56);
  expect(box?.height).toBeGreaterThanOrEqual(34);
});

test("без признака с сервера Настройки, Команда и «Ещё» — прежние", async ({ page }) => {
  await withShell(page, { enabled: true });
  for (const url of ["/settings", "/team", "/more"]) {
    await page.goto(url);
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    await expect(page.locator(".ry-set, .ry-teamp, .ry-more, .ry-swt")).toHaveCount(0);
  }
});
