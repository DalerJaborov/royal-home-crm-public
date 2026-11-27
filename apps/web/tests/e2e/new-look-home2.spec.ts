import { test, expect, type Page } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";
import { stubDirectorDashboard } from "./helpers/directorFixtures";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — ГЛАВНАЯ РУКОВОДИТЕЛЯ «КАК В МАКЕТЕ» (пачка home2, 27.11.2026): директор, админ и РОП
 * с правом на отчёты. Сверху блоки макета (components/look/home2), ниже «Аналитика» — дашборд
 * целиком (длинные имена — подменой сводки). На ширинах 320–1920 в светлой и тёмной теме нет
 * прокрутки вбок и ничего не вылезает за край; на ПК — две колонки как в макете, на телефоне —
 * одна (768–1024 — по ширине содержимого); шторка «Фильтры» открывается; без нового вида (`?look=legacy`) — прежняя главная.
 */
const ROLES = ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] as const;
const CHECK = [
  '[data-ry-section="home2"] :is(.h2-plate, .h2-mini, .h2-tile, .h2-q, .h2-speed, .h2-crew-person, .h2-cols, .h2-src, .ry-row, .ry-section-head)',
  '[data-ry-section="home2"] [data-ry-section="director"] :is(.dd-head, .dd-tile, .dd-card, .h2-fbar, .h2-fchip, .dd-agent-card)',
].join(", ");

async function lookOn(page: Page, on = true) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: on ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

for (const role of ROLES) {
  test(`главная ${role} как в макете: 320–1920, свет и тьма, две колонки на ПК @smoke`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
    test.setTimeout(300_000);
    const context = await contextForRole(browser, role, { baseURL, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await lookOn(page);
    await stubDirectorDashboard(page, { seesMoney: role !== "HEAD_OF_SALES" });
    await page.goto("/");
    const home = page.getByTestId("leader-home");
    await expect(home).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-block="analytics"] [data-testid="director-dashboard"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Аналитика", level: 2 })).toBeVisible();
    // Excel и Печать — в строке заголовка «Аналитики»; серых списков браузера нет.
    const analytics = page.locator('[data-block="analytics"]');
    await expect(analytics.getByRole("button", { name: "Excel" })).toBeVisible();
    await expect(analytics.getByRole("button", { name: "Печать" })).toBeVisible();
    await expect(analytics.locator("select")).toHaveCount(0);
    await expect(page.getByText("Не загрузилось")).toHaveCount(0);

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((night) => {
        document.documentElement.dataset.theme = night ? "royal-home-2026-night" : "royal-home-2026-light";
      }, theme === "dark");
      for (const width of LOOK_WIDTHS) {
        await expectNoOverflowAt(page, width, CHECK, { strips: ".dd-table-wrap, .dd-filters .ry-seg", textRoot: '[data-ry-section="home2"]' });
        // Колонки: на ПК правая колонка стоит справа от левой, на телефоне — под ней.
        const cols = await page.evaluate(() => {
          const box = (c: string) => document.querySelector(`[data-testid="leader-home"] [data-col="${c}"] [data-block]`)?.getBoundingClientRect();
          const a = box("a"); const b = box("b");
          return a && b ? { side: b.left > a.right - 1 } : null;
        });
        // 768–1024 — как хватит места (решает ширина содержимого, а не окна).
        if (cols && (width >= 1280 || width <= 430)) expect(cols.side, `${theme} ${width}: колонки`).toBe(width >= 1280);
      }
      // Тёмная тема по-настоящему: фон страницы тёмный.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const lum = bg.match(/\d+/g)!.slice(0, 3).map(Number).reduce((s, v) => s + v, 0) / 3;
      expect(lum, `${theme}: фон ${bg}`)[theme === "dark" ? "toBeLessThan" : "toBeGreaterThan"](128);
    }

    // Шторка «Фильтры»: выбор применяется и виден чипом.
    await page.setViewportSize({ width: 390, height: 844 });
    await analytics.getByRole("button", { name: /Фильтры/ }).click();
    const sheet = page.getByRole("dialog", { name: "Фильтры" });
    await sheet.getByRole("radio", { name: "Покупатели" }).click();
    await sheet.getByRole("button", { name: "Готово" }).click();
    await expect(analytics.getByText("Клиенты: Покупатели")).toBeVisible();
    await expectNoOverflowAt(page, 390, CHECK, { strips: ".dd-table-wrap, .dd-filters .ry-seg", textRoot: '[data-ry-section="home2"]' });
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("без признака вида главная директора прежняя: блоков макета нет @smoke", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(120_000);
  const context = await contextForRole(browser, "DIRECTOR", { baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  // Новый вид включён всем; без него — только личным выходом `?look=legacy` (hooks/royalLookChoice.ts).
  await lookOn(page, false);
  await page.goto("/?look=legacy");
  await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
  await expect(page.getByTestId("leader-home")).toHaveCount(0);
  await expect(page.locator('[data-ry-section="home2"]')).toHaveCount(0);
  await context.close();
});
