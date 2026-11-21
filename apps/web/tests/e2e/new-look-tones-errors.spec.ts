import { test, expect, type Page } from "@playwright/test";

/**
 * «НОВЫЙ ВИД»: цвет по смыслу (К13) и ошибка загрузки вместо вечного скелета (К14), аудит 20.11.2026.
 *
 * Ошибка: API «отрубается» целиком (route abort на все запросы данных, кроме входа и оболочки) — на пяти
 * ключевых экранах при ширине 390 за разумное время виден понятный текст и «Повторить»; после «Повторить» при
 * вернувшемся API экран показывает данные. Повторы запросов (окно RETRY_WINDOW_MS из lib/queryClient.ts) входят в ожидание.
 * Кадры снимаются, если задана SHOTS_DIR (метка — SHOTS_TAG: before / after).
 */
/** Понятные слова ошибки: «Не удалось загрузить…», «Не загрузилось», «Нет связи с сервером» (чат — отдельная пачка, у него своя фраза). */
const ERROR_TEXT = /Не удалось загрузить|Не загрузилось|не загрузил|Нет связи/i;
const SHOTS = process.env.SHOTS_DIR;
const TAG = process.env.SHOTS_TAG ?? "after";

async function withShell(page: Page) {
  await page.route("**/api/v1/ui-shell", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } }) : r.fallback());
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png`, fullPage: true });
}

/** Вход и оболочка живут; всё остальное из /api/v1 «обрывается» (как при пропавшей связи). */
const SESSION_URL = /\/api\/v1\/(auth\/|ui-shell|mission-control|me(\?|$|\/))/;
async function cutApi(page: Page) {
  await page.route("**/api/v1/**", (route) => (SESSION_URL.test(route.request().url()) ? route.fallback() : route.abort("connectionrefused")));
}
async function restoreApi(page: Page) {
  await page.unroute("**/api/v1/**");
  await withShell(page);
}

for (const [label, width, height] of [["m390", 390, 844], ["d1440", 1440, 900]] as const) {
  test(`цвет по смыслу ${label}: клиенты, звонки, обучение бота — без тревоги на обычном @tones`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
    test.setTimeout(120_000);
    await withShell(page);
    await page.setViewportSize({ width, height });

    await page.goto("/clients");
    await expect(page.locator(".ry-crow").first()).toBeVisible({ timeout: 30_000 });
    // «позвонить сейчас» (шаг просрочен) не спокойнее «ответить»: жёлтая (свежая просрочка) или красная (от суток), как дата.
    for (const chip of await page.locator(".ry-crow .ry-crow-step .chip").all()) {
      const text = (await chip.innerText()).trim().toLowerCase();
      if (text.startsWith("позвонить")) await expect(chip).toHaveClass(/\b(warn|crit)\b/);
    }
    await shot(page, `clients-${label}`);

    await page.goto("/calls");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    // Ни одной метки звонка с огнём: огонь — тревога, а не итог разговора.
    await expect(page.locator(".ry-call-flag svg[data-icon='flame'], .ry-call-flag .flame")).toHaveCount(0);
    await shot(page, `calls-${label}`);

    await page.goto("/ai-learning");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(4000);
    const act = page.locator(".tr-acts .tr-act").first();
    if (await act.count()) {
      // «Верно» и «Неверно» — не залитые зелёная и красная кнопки.
      for (const button of await page.locator(".tr-acts .tr-act").all()) {
        const bg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg, "кнопка «Верно/Неверно» не должна быть сплошной зелёной или красной").not.toMatch(/^rgb\((13|209|179|38|34), /);
      }
    }
    await shot(page, `ai-learning-${label}`);
  });
}

/** Ключевые экраны: путь и подпись для отчёта. Объект открывается по первой карточке списка. */
const SCREENS = [
  { name: "home", path: "/" },
  { name: "clients", path: "/clients" },
  { name: "messages", path: "/messages" },
  { name: "finance", path: "/finance" },
  { name: "object", path: "OBJECT" },
] as const;

for (const screen of SCREENS) {
  test(`ошибка загрузки 390: ${screen.name} — понятный текст и «Повторить», повтор работает @tones`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
    test.setTimeout(150_000);
    await withShell(page);
    await page.setViewportSize({ width: 390, height: 844 });

    let target: string = screen.path;
    if (screen.path === "OBJECT") {
      await page.goto("/properties");
      const href = await page.locator(".ry-obj-card .ry-obj-link").first().getAttribute("href", { timeout: 30_000 });
      expect(href, "в списке нет объекта — стенд без данных").toBeTruthy();
      target = href!;
    }
    await cutApi(page);
    await page.goto(target);

    const retry = page.getByRole("button", { name: "Повторить" }).first();
    await expect(retry, "после обрыва связи нет кнопки «Повторить» (вечный скелет)").toBeVisible({ timeout: 60_000 });
    // Скелет не остаётся вместо ошибки: к этому моменту (повторы кончились) серых плашек нет.
    await expect(page.locator(".ry-skeleton, .sk, [class*='skeleton']").locator("visible=true")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText(ERROR_TEXT).first()).toBeVisible({ timeout: 60_000 });
    // Текст ошибки не вплотную к краю: слева и справа не меньше 12 px.
    const box = await page.getByText(ERROR_TEXT).first().boundingBox();
    expect(box && box.x >= 12 && box.x + box.width <= 390 - 12, "текст ошибки прижат к краю экрана").toBe(true);
    await shot(page, `error-${screen.name}-m390`);

    // API вернулся: «Повторить» приводит данные. У экрана с несколькими блоками (главная, финансы) кнопка у каждого блока
    // своя, поэтому жмём по одной, пока они есть (это про кнопку; без сети данные приходят сами, см. тест «без сети» ниже).
    await restoreApi(page);
    for (let i = 0; i < 12; i++) {
      const button = page.getByRole("button", { name: "Повторить" }).first();
      if (!(await button.isVisible().catch(() => false))) break;
      await button.click();
      await page.waitForTimeout(700);
    }
    await expect(page.getByRole("button", { name: "Повторить" })).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(ERROR_TEXT)).toHaveCount(0);
  });
}

test("без сети 390: «Нет связи…», а когда связь вернулась, данные загружаются САМИ, без «Повторить» @tones", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
  test.setTimeout(150_000);
  await withShell(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toClients = page.locator("a[href='/clients']:visible").first();
  await expect(toClients).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  await context.setOffline(true);
  // Переход внутри приложения (без загрузки страницы): так и бывает, когда связь пропала посреди работы.
  await page.evaluate(() => { window.history.pushState({}, "", "/clients"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByText("Нет связи").first(), "без сети нет «Нет связи» (вечный скелет: запрос на паузе без слов)").toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Загрузим, как только она появится/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" }).first()).toBeVisible();
  await expect(page.getByText(/Не удалось загрузить|Карточка не найдена/i)).toHaveCount(0);
  await shot(page, "offline-clients-m390");
  // Связь вернулась: ни одного нажатия, запрос уходит сам и список появляется.
  await context.setOffline(false);
  await expect(page.locator(".ry-crow").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Нет связи")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Повторить" })).toHaveCount(0);
});

test("фоновая ошибка при уже загруженных данных не стирает экран 390 @tones", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
  test.setTimeout(150_000);
  await withShell(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/clients");
  await expect(page.locator(".ry-crow").first()).toBeVisible({ timeout: 30_000 });
  const rows = await page.locator(".ry-crow").count();
  // Данные считаются свежими 30 с (staleTime): ждём, пока запрос «протухнет», тогда возврат во вкладку его обновит.
  await page.waitForTimeout(31_000);
  let attempts = 0;
  await page.route("**/api/v1/**", (route) => {
    const url = route.request().url();
    if (SESSION_URL.test(url)) return route.fallback();
    if (/\/api\/v1\/clients(\?|$)/.test(url)) attempts++;
    // 404 не повторяется: обновление падает сразу, а данные в кэше остаются.
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "не найдено" }) });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => attempts, { message: "возврат во вкладку не перезапросил список (проверка была бы пустой)", timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);
  // Фоновая ошибка не стёрла список и не показала ошибку вместо данных.
  await expect(page.locator(".ry-crow")).toHaveCount(rows);
  await expect(page.getByText(ERROR_TEXT)).toHaveCount(0);
});

for (const [label, width, height] of [["m390", 390, 844], ["d1440", 1440, 900]] as const) {
  test(`деньги ${label}: сводка месяца не загрузилась — пояснение своей строкой во всю ширину карточки (К16) @tones`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
    test.setTimeout(120_000);
    await withShell(page);
    await page.setViewportSize({ width, height });
    // Падает только сводка месяца: остальное (список расходов) живёт, карточка месяца показывает пояснение.
    await page.route("**/api/v1/expenses/summary**", (route) => route.abort("connectionrefused"));
    await page.goto("/finance");
    const note = page.locator(".cef-feed > .cef-card:first-child > .cef-muted").first();
    await expect(note, "нет пояснения «Сводка месяца не загрузилась»").toBeVisible({ timeout: 90_000 });
    // Правило сетки живое (раньше комментарий между селекторами делал его мёртвым): строка занимает все колонки карточки.
    const column = await note.evaluate((el) => getComputedStyle(el).gridColumnEnd);
    expect(column).toBe("-1");
    const card = await page.locator(".cef-feed > .cef-card:first-child").boundingBox();
    const box = await note.boundingBox();
    expect(card && box && box.x >= card.x && box.x + box.width <= card.x + card.width + 1, "пояснение вылезло за карточку").toBe(true);
    await shot(page, `money-summary-error-${label}`);
  });
}
