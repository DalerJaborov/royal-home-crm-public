import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";
import { geometryFindings } from "./helpers/lookGeometry";

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

/** Каким был признак вида в момент, когда мастер впервые появился в документе (null — прежний вид). */
const WATCH_FIRST_FRAME = () => {
  const w = window as unknown as { __wizFirst?: string | null };
  w.__wizFirst = undefined;
  new MutationObserver(() => {
    if (w.__wizFirst === undefined && document.querySelector(".wiz")) w.__wizFirst = document.documentElement.dataset.uiLook ?? null;
  }).observe(document, { childList: true, subtree: true });
};
const firstFrame = (page: Page) => page.evaluate(() => (window as unknown as { __wizFirst?: string | null }).__wizFirst);

for (const look of [true, false]) {
  test(`переход внутри приложения список → мастер → список: признак вида ${look ? "не теряется и мастер не мигает" : "не появляется"}`, async ({ page }) => {
    await shell(page, look);
    await page.goto("/properties");
    await expect(page.locator("main#main")).toBeVisible({ timeout: 30_000 });
    const attr = page.locator("html");
    const expectLook = async () => look
      ? expect(attr).toHaveAttribute("data-ui-look", "royal")
      : expect(attr).not.toHaveAttribute("data-ui-look", /.+/);
    await expectLook();
    await page.evaluate(WATCH_FIRST_FRAME);
    // Переход внутри приложения (как по кнопке), без перезагрузки: ответ /ui-shell уже в кэше.
    await page.evaluate(() => { history.pushState(null, "", "/properties/new?draft=continue"); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.locator(".wiz .whead")).toBeVisible({ timeout: 30_000 });
    expect(await firstFrame(page), "первый кадр мастера").toBe(look ? "royal" : null);
    await expectLook();
    await expect(page.locator('[data-ry-section="wizard"]')).toHaveCount(look ? 1 : 0);
    await page.goBack();
    await expect(page).toHaveURL(/\/properties$/);
    await expect(page.locator("main#main")).toBeVisible({ timeout: 30_000 });
    await expectLook();
    await expect(page.locator('[data-ry-section="wizard"]')).toHaveCount(0);
  });
}

test("холодный заход в мастер: пока ответ сервера в пути — запомненный признак, после ответа решает сервер", async ({ page }) => {
  await shell(page, true);
  await openWizard(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  // Ответ /ui-shell задержан: без запомненного признака мастер нарисовался бы старым и перекрасился.
  const slowShell = async (body: Record<string, unknown>) => {
    await page.unroute("**/api/v1/ui-shell");
    await page.route("**/api/v1/ui-shell", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await new Promise((r) => setTimeout(r, 2_500));
      await route.fulfill({ json: body, headers: { "cache-control": "no-store" } });
    });
  };
  await page.addInitScript(WATCH_FIRST_FRAME);
  await slowShell({ enabled: true, look: "royal" });
  await page.reload();
  await expect(page.locator(".wiz .whead")).toBeVisible({ timeout: 30_000 });
  expect(await firstFrame(page), "первый кадр мастера при холодном заходе").toBe("royal");
  await page.waitForTimeout(3_000);
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  // Вид выключили на сервере: запомненное не залипает — после ответа атрибута нет.
  await slowShell({ enabled: true });
  await page.reload();
  await expect(page.locator(".wiz .whead")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/, { timeout: 10_000 });
  await expect(page.locator("[data-ry-section]")).toHaveCount(0);
});

/**
 * Строка видео в блоке «Видео» мастера (21.11.2026, iPhone владельца): «IMG_1210.MOV» и «109.4 МБ ·
 * Готово» стояли столбиком по одной букве — чип «Исходник монтажёру» и кнопка «Убрать» не сжимались и
 * съедали всю строку. Имя — в одну строку (хвост «.MOV» виден), кнопки уходят на вторую строку, а не
 * сжимают имя. Ловит helpers/lookGeometry.ts (letterColumn, squeeze, overlap, wordBreak); поломка внесена
 * нарочно — сторож обязан её увидеть.
 */
test("новый вид: строка видео в мастере не рвёт имя файла по буквам на 320–430 @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(240_000);
  await shell(page, true);
  // Разделы листаются ссылками на ПК; шаг остаётся выбранным, когда окно сужается до телефона.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWizard(page);
  await page.getByTestId("wizard-step-media").click();
  await expect(page.locator('.wiz[data-step-key="media"]')).toBeVisible();
  await page.getByTestId("wizard-video-input").setInputFiles({
    name: "IMG_1210.MOV",
    mimeType: "video/quicktime",
    buffer: Buffer.alloc(2048, 1),
  });
  const row = page.getByTestId("wizard-video-row").first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // overlap страницы целиком тут не годится: липкий низ мастера по замыслу лежит над концом шага;
  // наезд внутри строки проверяется ниже по коробкам имени и кнопок.
  const kinds = ["letterColumn", "squeeze", "wordBreak", "smallText", "smallTap"] as const;
  for (const width of [320, 360, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await geometryFindings(page, { kinds }), `строка видео на ${width}`).toEqual([]);
    // Имя читается: одна строка, и расширение не потеряно.
    const nm = row.locator(".nm");
    expect((await nm.boundingBox())!.height, `имя файла на ${width} в одну строку`).toBeLessThan(40);
    await expect(nm).toContainText("MOV");
    const nmBox = (await row.locator(".info").boundingBox())!;
    for (const part of await row.locator(".act > *").all()) {
      const b = await part.boundingBox();
      if (!b) continue; // скрытое поле выбора файла
      const apart = b.x >= nmBox.x + nmBox.width - 1 || b.x + b.width <= nmBox.x + 1 || b.y >= nmBox.y + nmBox.height - 1 || b.y + b.height <= nmBox.y + 1;
      expect(apart, `кнопка строки видео наехала на имя файла на ${width}`).toBe(true);
    }
    await expectNoOverflowAt(page, width, ".wiz .vrow, .wiz .vrow > *");
  }
  // Нарочная поломка: чип и кнопка не переносятся и не сжимаются — колонка имени схлопывается.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addStyleTag({
    content: ".wiz .vrow { flex-wrap: nowrap !important; } .wiz .vrow .nm { overflow-wrap: anywhere !important; text-overflow: clip !important; white-space: normal !important; } .wiz .vrow .nm * { white-space: normal !important; overflow: visible !important; } .wiz .vrow > * { flex-shrink: 0 !important; } .wiz .vrow > div:first-of-type { flex: 0 0 14px !important; min-width: 14px !important; max-width: 14px !important; } .wiz .vrow .act { flex-wrap: nowrap !important; }",
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect((await geometryFindings(page, { kinds: ["letterColumn"] })).length, "letterColumn: нарочная поломка не поймана").toBeGreaterThan(0);
});
