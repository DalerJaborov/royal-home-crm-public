import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — мастер «Новый объект» и форма «Изменить объект» (пачка wizard,
 * 20.11.2026): сторож вёрстки.
 *
 * Ответ /ui-shell подменяется, как в остальных new-look-*: правило сервера проверяют
 * тесты API. На девяти ширинах каждый шаг мастера, окно «Куда пойдёт объект» и форма
 * правки не дают горизонтальной прокрутки, ни один блок не вылез за край, текст с
 * данными не обрезан многоточием. Мастер живёт СНАРУЖИ AppLayout — отдельно проверено,
 * что признак вида до него доходит (атрибут ставит сама страница) и что без признака с
 * сервера ни атрибута, ни метки раздела нет.
 */
const CHECK = ".wiz .whead, .wiz .blk, .wiz .wfoot, .wiz .wfoot > *, .wiz .mode, .wiz .segs button, .wiz .f, .wiz .sugg, .wiz .wizard-steps, .wiz .panel";
const EDIT_CHECK = ".pg-h, .card, .fld, .pgrid, .sheet-f > *, .quiet, .rh-select";
const STEPS = ["seller", "media", "main", "place", "review"] as const;

async function shell(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

/** Мастер без вопроса о черновике: `?draft=continue` — тот же путь, что кнопка «Продолжить» на списке. */
async function openWizard(page: Page) {
  await page.goto("/properties/new?draft=continue");
  await expect(page.locator(".wiz .whead")).toBeVisible({ timeout: 30_000 });
}

test("новый вид: первый экран мастера без горизонтальной прокрутки на всех ширинах @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(240_000);
  await shell(page, true);
  for (const width of LOOK_WIDTHS) {
    // Каждая ширина — свой заход: телефон и ПК у мастера раскладываются по-разному.
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/properties/new");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
    await expect(page.locator('.rh2[data-ry-section="wizard"]').first()).toBeAttached();
    await expect(page.locator(".wiz .wfoot, .wiz .whead").first()).toBeVisible({ timeout: 30_000 });
    await expectNoOverflowAt(page, width, CHECK);
  }
});

for (const step of STEPS) {
  test(`новый вид: шаг «${step}» мастера держится на всех ширинах`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await shell(page, true);
    // Разделы листаются ссылками на ПК; шаг остаётся выбранным, когда окно сужается до телефона.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWizard(page);
    await page.getByTestId(`wizard-step-${step}`).click();
    await expect(page.locator(`.wiz[data-step-key="${step}"]`)).toBeVisible();
    for (const width of LOOK_WIDTHS) await expectNoOverflowAt(page, width, CHECK);
  });
}

test("новый вид: окно «Куда пойдёт объект» на телефоне и ПК", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка в десктопном проекте");
  await shell(page, true);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openWizard(page);
    await page.getByTestId("wizard-mode-chip").click();
    await expect(page.getByTestId("wizard-mode-sheet")).toBeVisible();
    await expectNoOverflowAt(page, width, ".wiz .panel, .wiz .pick2, .wiz .panel > .ghost");
    await page.getByTestId("wizard-mode-close").click();
  }
});

test("новый вид: форма «Изменить объект» без горизонтальной прокрутки", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(240_000);
  await shell(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Объект №1 сида стенда: в продаже, не на сайте — форма открывается, а не замок «объект опубликован».
  await page.goto("/properties/1/edit");
  await expect(page.locator('.rh2.screens[data-ry-section="wizard"] .pg-h h1')).toBeVisible({ timeout: 30_000 });
  for (const width of LOOK_WIDTHS) await expectNoOverflowAt(page, width, EDIT_CHECK);
});

test("без признака с сервера мастер и форма правки прежние: ни атрибута, ни метки раздела", async ({ page }) => {
  await shell(page, false);
  await page.goto("/properties/new?look=royal");
  await expect(page.locator(".wiz .whead")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator("[data-ry-section]")).toHaveCount(0);
  await page.goto("/properties/1/edit");
  await expect(page.locator(".pg-h h1")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator("[data-ry-section]")).toHaveCount(0);
});
