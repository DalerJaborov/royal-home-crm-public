import { test, expect } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";

/**
 * Агент находит сделку — на ПК и на телефоне (23.09.2026).
 *
 * Жалоба владельца: «агенты не могут найти даже кнопку „Сделка“». Причин было
 * три, и ни одну не видят сборка и тесты API:
 *  - после сокращения вкладок «Клиентов» до двух «Сделки» не открывались ни из
 *    меню, ни из вкладок;
 *  - карточка клиента не показывала его сделку: блок «Где сделка» рисовал
 *    статус клиента;
 *  - «Новая сделка» уводила в список клиентов, а форма на странице объекта
 *    пряталась за режимом правки.
 *
 * Проверяем путь целиком под агентом из сида: пункт меню, шторка «Новая
 * сделка» → клиент → объект → форма сделки с уже выбранным клиентом.
 */
test("агент находит «Сделки» и заводит сделку через шторку @smoke", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "обе ширины проверяются одним прогоном на chromium");
  const context = await contextForRole(browser, "AGENT");
  const page = await context.newPage();

  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    const phone = size.width < 640;

    // 1. Пункт меню: боковая рейка на ПК, «Ещё» на телефоне.
    await page.goto(phone ? "/more" : "/");
    // Строки «Ещё» — кнопки, пункты рейки — ссылки; ищем по видимой подписи.
    await expect(page.getByText("Сделки", { exact: true }).locator("visible=true").first(), `меню на ${size.width}`).toBeVisible({
      timeout: 15_000,
    });

    // 2. Шторка «Новая сделка» ведёт к форме с выбранным клиентом.
    await page.goto("/deals");
    await page.getByRole("button", { name: "Новая сделка" }).click();
    const sheet = page.locator(".sheet-b");
    const firstClient = sheet.locator("button.row").first();
    await expect(firstClient).toBeVisible({ timeout: 15_000 });
    const clientName = (await firstClient.innerText()).trim();
    await firstClient.click();
    await sheet.locator("button.row").first().click();

    await expect(page).toHaveURL(/\/properties\/\d+/);
    const select = page.locator("#deal-assign select");
    await expect(select, `форма сделки на ${size.width}`).toBeVisible({ timeout: 15_000 });
    await expect(select.locator("option:checked")).toHaveText(clientName);
  }

  await context.close();
});
