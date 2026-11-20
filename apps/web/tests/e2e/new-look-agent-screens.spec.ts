import { test, expect, type Page } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";

/**
 * «НОВЫЙ ВИД» — экраны агента (пачка D1, 20.11.2026). Три ключевых пути агента:
 *  1) позвонить из карточки клиента: номер и «Позвонить» на первом экране телефона,
 *     «Следующий шаг» сразу под ними;
 *  2) найти объект по району и цене: до первого объекта два ряда управления, дальше
 *     «Фильтры» → район → цена → «Показать»;
 *  3) мастер: «Удалить черновик» не рядом с «Сохранить и выйти» и только через подтверждение.
 * Ответ /ui-shell подменяется (правило сервера проверяют тесты API), как в new-look-*.spec.ts.
 */
async function royalShell(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}
/** Агенту на телефоне новый вид пока даётся только локальным предпросмотром (оболочку ведёт пачка B). */
const PHONE = "shell=clean&agentMobilePreview=1";

async function firstClientShortId(page: Page): Promise<number> {
  await page.goto(`/clients?${PHONE}`);
  const link = page.locator('a.ry-crow-main[href^="/clients/"]').first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  return Number((await link.getAttribute("href"))!.split("/").pop());
}

test("агент: позвонить из карточки клиента — номер, «Позвонить» и «Следующий шаг» на первом экране телефона", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "свой контекст агента на ширине телефона");
  const context = await contextForRole(browser, "AGENT", { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await royalShell(page);
  const shortId = await firstClientShortId(page);

  // Строка списка: имя отдельно от запроса, одна дата с глаголом.
  const row = page.locator(".ry-crow").first();
  await expect(row.locator(".ry-crow-name")).not.toContainText("ищет");
  await expect(row.locator(".ry-crow-when")).toContainText(/срок|просрочено|связывались/);

  let called = false;
  await page.route("**/api/v1/clients/*/call", (route) => { called = true; return route.fulfill({ json: { ok: true } }); });
  await page.goto(`/clients/${shortId}?${PHONE}`);
  const callButton = page.locator(".cd-actbar").getByRole("button", { name: /Позвонить/ });
  await expect(callButton).toBeVisible({ timeout: 30_000 });
  const firstScreen = page.viewportSize()!.height;
  expect((await callButton.boundingBox())!.y).toBeLessThan(firstScreen);
  const nextStep = page.locator(".scr > .client-next-step");
  await expect(nextStep).toBeVisible();
  expect((await nextStep.boundingBox())!.y).toBeLessThan(firstScreen);
  // Без переписки бледной «Написать» нет вовсе — кнопка без причины читалась поломкой.
  await expect(page.locator(".cd-actbar button:disabled", { hasText: "Написать" })).toHaveCount(0);
  await callButton.click();
  await expect.poll(() => called).toBe(true);
  await context.close();
});

test("агент: объект по району и цене — два ряда управления и шторка фильтров", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "свой контекст агента на ширине телефона");
  const context = await contextForRole(browser, "AGENT", { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await royalShell(page);
  await page.goto(`/properties?${PHONE}`);
  await expect(page.locator(".ry-objects-page")).toBeVisible({ timeout: 30_000 });
  const firstCard = page.locator(".ry-obj-card").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  // До первого объекта: шапка и один ряд «поиск + Фильтры». Стадий, «Мои/Все», вида и «Список/Карта» над списком нет.
  await expect(page.locator('[aria-label="Стадии объектов"]:visible')).toHaveCount(0);
  await expect(page.locator(".ry-objects-page .seg-ai")).toHaveCount(0);
  const bar = page.locator(".ry-catalog-bar");
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  expect(barBox.height).toBeLessThan(64); // один ряд, без переноса
  expect((await firstCard.boundingBox())!.y).toBeLessThan(barBox.y + barBox.height + 40);

  // Фильтры → район → цена до → «Показать».
  await bar.getByRole("button", { name: /Фильтры/ }).click();
  const sheet = page.getByRole("dialog", { name: "Фильтры объектов" });
  await expect(sheet).toBeVisible();
  const district = sheet.locator("label.chk").filter({ hasText: /Сино/ }).first();
  await district.click();
  await sheet.getByLabel("Цена до, сомони").fill("1000000");
  const listed = page.waitForRequest((r) => r.url().includes("/api/v1/properties?") && r.url().includes("priceMax=1000000") && r.url().includes("districtIds="));
  await sheet.getByRole("button", { name: /^Показать/ }).click();
  await listed;
  await expect(page).toHaveURL(/priceMax=1000000/);
  await expect(bar.locator(".ry-catalog-count")).toHaveText("2");

  // Строкой поиска находит по имени района.
  await page.goto(`/properties?${PHONE}`);
  const byName = page.waitForResponse((r) => r.url().includes("/api/v1/properties?") && /q=%D0%A1%D0%B8%D0%BD%D0%BE|q=Сино/.test(r.url()));
  await page.locator(".ry-catalog-bar .inp").fill("Сино");
  expect((await byName).ok()).toBe(true);
  await expect(page.locator(".ry-obj-card").first()).toContainText("Сино");
  await context.close();
});

test("агент: мастер — «Удалить черновик» отдельно от «Сохранить и выйти» и через подтверждение", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "свой контекст агента");
  for (const width of [320, 1440]) {
    const context = await contextForRole(browser, "AGENT", { viewport: { width, height: width < 768 ? 640 : 900 } });
    const page = await context.newPage();
    await royalShell(page);
    await page.goto(`/properties/new${width < 768 ? `?${PHONE}` : ""}`);
    const save = page.getByTestId("wizard-save-exit");
    await expect(save).toBeVisible({ timeout: 30_000 });
    // Удаления нет в шапке рядом с сохранением.
    await expect(page.locator(".wizard-header-actions [data-testid='wizard-delete-draft']")).toHaveCount(0);
    const del = page.getByTestId("wizard-delete-draft");
    // Нижняя панель мастера липкая: кнопка — последняя в форме, к ней доходят прокруткой до конца.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(del).toBeVisible();
    // Кнопку ничто не накрывает (нижняя панель мастера в том числе).
    const box = (await del.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid='wizard-delete-draft']") !== null, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toBe(true);
    // Шаги-полоски — в один ряд.
    const bars = page.locator(".wiz .bars");
    if (await bars.isVisible()) expect((await bars.boundingBox())!.height).toBeLessThan(24);
    await del.click();
    const confirm = page.getByRole("alertdialog", { name: /Удалить черновик\?/ });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await context.close();
  }
});
