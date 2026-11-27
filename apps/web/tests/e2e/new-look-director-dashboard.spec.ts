import { test, expect, type Browser, type Page } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";
import { stubDirectorDashboard } from "./helpers/directorFixtures";
import { expectNoOverflowAt } from "./helpers/noOverflow";
import { IPHONE_UA, geometryFindings } from "./helpers/lookGeometry";

/**
 * Дашборд руководителя на главной «/» (21.11.2026): директор видит всё, РОП без права на деньги —
 * без денег (плиток, столбцов и кольца нет в разметке вовсе). С 27.11.2026 (пачка home2) над ним —
 * блоки макета (components/look/home2), а сам дашборд — «Аналитика» ниже; прежней полосы «Требует
 * внимания» и старых блоков главной директора нет. Агент — прежняя главная, /director для
 * руководителя ведёт на «/». Ответы дашборда подменены. 390 и 1440.
 */
const SIZES = [{ name: "390", width: 390, height: 844 }, { name: "1440", width: 1440, height: 900 }] as const;

async function open(browser: Browser, baseURL: string | undefined, role: RoleName, size: (typeof SIZES)[number], seesMoney: boolean, stub = true, path = "/") {
  const phone = size.width < 820;
  const context = await contextForRole(browser, role, {
    baseURL, serviceWorkers: "block", viewport: { width: size.width, height: size.height },
    ...(phone ? { userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  await page.route("**/api/v1/ui-shell", (r) => r.request().method() === "GET" ? r.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } }) : r.fallback());
  if (stub) await stubDirectorDashboard(page, { seesMoney });
  await page.goto(path);
  return { context, page };
}

/** Главная руководителя: блоки макета сверху и «Аналитика» под ними; старой полосы и старой главной нет. */
async function expectDashboardHome(page: Page) {
  await expect(page.getByTestId("leader-home")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-block="analytics"]')).toHaveCount(1);
  for (const id of ["attention", "dashboard", "money", "pulse", "channels", "full"]) await expect(page.locator(`[data-block="${id}"]`), id).toHaveCount(0);
  await expect(page.locator('[data-block="tiles"]')).toHaveCount(1);
  // «Аналитика» — ниже блоков макета.
  const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
  expect(await y('[data-block="analytics"]')).toBeGreaterThan(await y('[data-testid="leader-home"]'));
}

const money = (page: Page) => page.locator('[data-kpi="revenue"], #dd-plan, .dd-table th:has-text("Комиссия")');

for (const size of SIZES) {
  test(`дашборд директора: директор видит деньги, цифры и список за плиткой, ${size.name} @smoke`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины задаются внутри теста");
    test.setTimeout(120_000);
    const { context, page } = await open(browser, baseURL, "DIRECTOR", size, true);
    const root = page.locator('[data-ry-section="director"] [data-testid="director-dashboard"]');
    await expect(root.getByRole("heading", { name: "Аналитика", level: 2 })).toBeVisible({ timeout: 30_000 });
    await expectDashboardHome(page);
    await expect(page.locator('[data-kpi="newLeads"]')).toContainText("148");
    await expect(page.locator('[data-kpi="newLeads"]')).toContainText("на 27 заявок больше, чем в прошлом периоде");
    // Рост «без контакта» — плохо: красное, а не зелёное.
    await expect(page.locator('[data-kpi="noContact"] .dd-delta')).toHaveAttribute("data-tone", "bad");
    await expect(money(page).first()).toBeVisible();
    await expect(page.locator("#dd-plan")).toContainText("80");
    await expect(root.getByText(/обновлено в \d\d:\d\d/)).toBeVisible();
    // У директора план идёт выше плиток.
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    expect(await y("#dd-plan")).toBeLessThan(await y("#dd-speed"));
    // Клик по плитке — список записей, строка ведёт в карточку клиента.
    await page.locator('[data-kpi="noContact"]').click();
    const drill = page.getByTestId("director-drill");
    await expect(drill.getByRole("link").first()).toHaveAttribute("href", /\/clients\/c0$/);
    await page.keyboard.press("Escape");
    await expect(drill).toHaveCount(0);
    if (size.width >= 820) {
      // Таблица менеджеров сортируется по любому столбцу.
      const th = page.locator('.dd-table th:has-text("Заявки")');
      await th.locator("button").click();
      await expect(th).toHaveAttribute("aria-sort", "descending");
      await expect(page.locator(".dd-table tbody tr").first()).toContainText("Абдурахмонзода");
      await th.locator("button").click();
      await expect(th).toHaveAttribute("aria-sort", "ascending");
      await expect(page.locator(".dd-table tbody tr").first()).toContainText("Сухроб");
    } else {
      await expect(page.locator(".dd-agent-card").first()).toBeVisible();
    }
    await expectNoOverflowAt(page, size.width, ".dd-card, .dd-tile, .ry-row, .dd-agent-card, .dd-head, .dd-filters, .h2-fbar, .h2-plate, .h2-tile, .h2-cols, .h2-q, .h2-crew-person", { strips: ".dd-table-wrap, .dd-filters .ry-seg" });
    expect(await geometryFindings(page, { kinds: ["smallText", "smallTap", "selectClip", "fieldFrame"] }), "геометрия").toEqual([]);
    await context.close();
  });
}

for (const role of ["HEAD_OF_SALES"] as const) {
  for (const size of SIZES) {
    test(`дашборд директора: ${role} без права на деньги — денег в разметке нет, ${size.name} @smoke`, async ({ browser, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "ширины задаются внутри теста");
      test.setTimeout(120_000);
      const { context, page } = await open(browser, baseURL, role, size, false);
      const root = page.locator('[data-testid="director-dashboard"]');
      await expect(root.getByRole("heading", { name: "Аналитика", level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-kpi="newLeads"]')).toBeVisible();
      await expect(money(page)).toHaveCount(0);
      await expect(root).not.toContainText("Выручка");
      await expect(root).not.toContainText("План и факт");
      await expectDashboardHome(page);
      {
        // У РОП сверху — скорость ответа и менеджеры, период по умолчанию — «Неделя».
        await expect(root.getByRole("radio", { name: "Неделя" })).toHaveAttribute("aria-checked", "true");
        const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
        expect(await y("#dd-speed")).toBeLessThan(await y("#dd-kpi"));
        expect(await y("#dd-agents")).toBeLessThan(await y("#dd-kpi"));
      }
      await expectNoOverflowAt(page, size.width, ".dd-card, .dd-tile, .ry-row, .dd-agent-card, .dd-head, .dd-filters, .h2-fbar, .h2-plate, .h2-tile, .h2-cols, .h2-q, .h2-crew-person", { strips: ".dd-table-wrap, .dd-filters .ry-seg" });
      await context.close();
    });
  }
}

test("дашборд директора: старый адрес /director ведёт директора на главную @smoke", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  test.setTimeout(120_000);
  const { context, page } = await open(browser, baseURL, "DIRECTOR", SIZES[1], true, true, "/director");
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expectDashboardHome(page);
  await expect(page.locator('a[href="/director"]')).toHaveCount(0);
  await context.close();
});

test("главная агента: прежняя, без дашборда руководителя @smoke", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  test.setTimeout(120_000);
  const { context, page } = await open(browser, baseURL, "AGENT", SIZES[1], true);
  await expect(page.locator('[data-block="agentTiles"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="director-dashboard"]')).toHaveCount(0);
  await expect(page.locator('[data-block="attention"]')).toHaveCount(0);
  await context.close();
});

test("дашборд директора: агенту экран закрыт и в меню его нет @smoke", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  const { context, page } = await open(browser, baseURL, "AGENT", SIZES[1], true, true, "/director");
  await expect(page.getByText("Нет доступа к этому разделу")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="director-dashboard"]')).toHaveCount(0);
  await expect(page.locator('a[href="/director"]')).toHaveCount(0);
  await context.close();
});

test("дашборд директора: живой ответ сервера (без подмены) рисуется без ошибок @smoke", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  const { context, page } = await open(browser, baseURL, "DIRECTOR", SIZES[1], true, false);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const root = page.locator('[data-testid="director-dashboard"]');
  await expect(root.getByRole("heading", { name: "Аналитика", level: 2 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-kpi="newLeads"]')).toBeVisible({ timeout: 30_000 });
  await expect(root.getByText("Не загрузилось")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});
