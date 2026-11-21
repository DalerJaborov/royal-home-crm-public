import { test, expect, type Browser, type Page } from "@playwright/test";
import { expectNoOverflowAt } from "./helpers/noOverflow";
import { contextForRole, type RoleName } from "./pages/roleAuth";

/**
 * «НОВЫЙ ВИД» — ГЛАВНЫЕ РУКОВОДИТЕЛЕЙ (20.11.2026): директор, РОП и акционер на 390 и 1440,
 * светлая и тёмная тема. На настоящих данных стенда (без подмены чисел): нет горизонтальной
 * прокрутки и вылезания за край; цвет плиток — только по смыслу (ноль серый, срочное
 * красное, чёрной плитки тревоги нет); у каждой роли свой набор; деньги — только тем, кому
 * их отдаёт сервер (РОП их не видит вовсе).
 */
const ROLES = ["DIRECTOR", "HEAD_OF_SALES", "SHAREHOLDER"] as const satisfies readonly RoleName[];
type Role = (typeof ROLES)[number];

/** Вход — общим помощником (pages/roleAuth.ts): состояние роли кэшируется на диск, лимит кодов за час не выбирается. */
async function roleContext(browser: Browser, role: Role, baseURL: string | undefined) {
  return contextForRole(browser, role, { baseURL, serviceWorkers: "block" });
}

async function lookOn(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

const CHECK = ['[data-ry-section="home"] .ry-tile', '[data-ry-section="home"] .ry-hero', '[data-ry-section="home"] .ry-row',
  '[data-ry-section="home"] .ry-section-head', '[data-ry-section="home"] .ry-home-chart', '[data-ry-section="home"] .ry-home-quiet'].join(", ");

/** Что обязано быть и чего быть не должно у роли. */
const EXPECT: Record<Role, { blocks: string[]; absent: string[]; money: boolean }> = {
  // Директор и РОП (21.11.2026): главная = полоса «Требует внимания сейчас» и дашборд; старых блоков нет.
  DIRECTOR: { blocks: ["attention", "dashboard"], absent: ["money", "decisions", "burning", "team", "pulse", "managerTiles", "ropTiles"], money: true },
  HEAD_OF_SALES: { blocks: ["attention", "dashboard"], absent: ["ropTiles", "ropSpread", "ropTeam", "ropTasks", "teamCharts", "money", "managerTiles"], money: false },
  SHAREHOLDER: { blocks: ["money", "pulse", "channels"], absent: ["managerTiles", "decisions", "managerFocus", "ropTiles"], money: true },
};

for (const role of ROLES) {
  test(`новый вид, главная руководителя ${role}: 390 и 1440, свет и тьма, цвет по смыслу @smoke`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
    test.setTimeout(240_000);
    const context = await roleContext(browser, role, baseURL);
    const page = await context.newPage();
    await lookOn(page);
    const money = page.waitForResponse((r) => r.url().includes("/api/v1/dashboard/mission-control/live"), { timeout: 30_000 }).catch(() => null);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
    const home = page.locator(`.ry-today[data-ry-section="home"][data-role="${role}"]`);
    await expect(home.locator(".ry-section, .ry-strip").first()).toBeVisible({ timeout: 30_000 });
    const live = await money;
    const seesMoney = live ? Boolean((await live.json().catch(() => ({})) as { seesMoney?: boolean }).seesMoney) : false;
    expect(seesMoney, "деньги в снимке пульта — как отдаёт сервер").toBe(EXPECT[role].money);

    for (const id of EXPECT[role].blocks) await expect(home.locator(`[data-block="${id}"]`), id).toHaveCount(1);
    for (const id of EXPECT[role].absent) await expect(home.locator(`[data-block="${id}"]`), id).toHaveCount(0);
    if (role === "SHAREHOLDER") await expect(home.locator('[data-hero="money"]')).toBeVisible();
    else await expect(home.locator('[data-hero="money"]')).toHaveCount(0);
    await expect(page.getByText("Не загрузилось")).toHaveCount(0);

    // Цвет по смыслу: ноль — серая, срочное больше нуля — красная; чёрной плитки тревоги нет.
    await expect(home.locator('.ry-tile[data-variant="ink"]')).toHaveCount(0);
    const tiles = await home.locator(".ry-tile").evaluateAll((els) => els.map((el) => ({
      variant: el.getAttribute("data-variant"),
      value: (el.querySelector(".ry-tile-value")?.textContent ?? "").replace(/\s/g, ""),
    })));
    for (const t of tiles) if (t.value === "0") expect(t.variant, `плитка с нулём: ${JSON.stringify(t)}`).toBe("calm");

    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((night) => {
          if (night) document.documentElement.dataset.theme = "royal-home-2026-night";
          else document.documentElement.dataset.theme = "royal-home-2026-light";
        }, theme === "dark");
        await expectNoOverflowAt(page, width, CHECK, { height, strips: ".rh2-bar-chart", textRoot: '[data-ry-section="home"]' });
        // Плитка «спокойно» и «срочно» отличаются от фона страницы в обеих темах (не сливаются).
        const contrast = await page.evaluate(() => {
          const bg = getComputedStyle(document.body).backgroundColor;
          return [...document.querySelectorAll('[data-ry-section="home"] .ry-tile[data-variant="calm"], [data-ry-section="home"] .ry-tile[data-variant="crit"]')]
            .map((el) => ({ bg: getComputedStyle(el).backgroundColor, page: bg }));
        });
        for (const c of contrast) expect(c.bg, `${theme} ${width}`).not.toBe(c.page);
      }
    }
    await context.close();
  });
}
