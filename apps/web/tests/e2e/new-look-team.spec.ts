import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», пачка team: Команда, активность, Настройки (все группы), «Ещё».
 *
 * Ответ /ui-shell подменяется, как в new-look.spec.ts. Ширина — общим сторожем
 * helpers/noOverflow.ts: не только прокрутка документа, но и элемент, уехавший за
 * край режущего предка (так пряталась маршрутизация звонков, ревью PR 279). В
 * настройках все разделы раскрываются: проверяется то, что увидит человек.
 */
const SCREENS: { url: string; ready: string }[] = [
  { url: "/settings", ready: ".ry-set" },
  { url: "/settings?tab=agency", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=money", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=leads", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=matching", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=team", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=channels&task=phone", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=bot&task=operation", ready: ".ry-set .ry-acc" },
  { url: "/settings?tab=system&task=workspace", ready: ".ry-set .ry-task-head" },
  { url: "/settings?tab=system&task=data", ready: ".ry-set .ry-task-head" },
  { url: "/team", ready: ".ry-teamp" },
  { url: "/activity", ready: ".ry-activity" },
  { url: "/more", ready: ".ry-more" },
];
/** Что проверять на вылет: элементы экранов пачки, которые человек видит и нажимает. */
const ITEMS = '[data-ry-section="team"] :is(.ry-row, .ry-swt, .ry-setrow, .acc-h, .mod, .seg button, .pill, .ry-pill, .ry-btn, .tile, .fld, .ry-mrow)';

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

async function openAllSections(page: Page) {
  // Разделы появляются после ответа сервера — раскрывать, когда данные пришли.
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let round = 0; round < 3; round++) {
    const closed = page.locator('[data-ry-section="team"] .ry-acc > .acc-h[aria-expanded="false"]');
    const count = await closed.count();
    if (count === 0) return;
    for (let i = 0; i < count; i++) await closed.first().click().catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
  }
}

for (const screen of SCREENS) {
  test(`новый вид team: ${screen.url} — ничего не вылезает на всех ширинах`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    await withShell(page, { enabled: true, look: "royal" });
    await page.goto(screen.url);
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    // Вкладка бота грузится отдельным куском — первый заход в dev бывает долгим.
    await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
    await openAllSections(page);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // Смена телефонного вида на ПК пересобирает экран и сворачивает разделы — раскрыть снова.
      await openAllSections(page);
      // Задуманные ленты с собственной прокруткой; ряды выбора .hscroll — лента только в
      // телефонном виде (data-mobile-ux), на ПК они обязаны переноситься (ревью PR 279).
      const phone = await page.evaluate(() => document.documentElement.hasAttribute("data-mobile-ux"));
      const strips = `.seg-ai, .ry-set-tasks, .clean-section-switcher, .ry-chips${phone ? ", .hscroll" : ""}`;
      await expectNoOverflowAt(page, width, ITEMS, { strips });
    }
  });
}

test("новый вид team: переключатели настроек не меньше 56×34, слово состояния рядом", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка вёрстки в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/settings?tab=bot&task=operation");
  await expect(page.locator(".ry-set .ry-acc").first()).toBeVisible({ timeout: 30_000 });
  await openAllSections(page);
  const tile = page.locator(".ry-set .ry-swt").first();
  await expect(tile).toBeVisible();
  const box = await tile.locator(".tgl i").boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(56);
  expect(box?.height).toBeGreaterThanOrEqual(34);
  await expect(tile.locator(".ry-swt-ctl")).toContainText(/Включено|Выключено/);
});

test("без признака с сервера Настройки, Команда и «Ещё» — прежние", async ({ page }) => {
  await withShell(page, { enabled: true });
  for (const url of ["/settings", "/team", "/more"]) {
    await page.goto(url);
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    await expect(page.locator('[data-ry-section], .ry-swt')).toHaveCount(0);
  }
});
