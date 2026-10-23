import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * «СТАТИСТИКА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026) — светофор, путь покупателя,
 * соседи, график сайта, площадки. На компьютере — вкладка, на телефоне —
 * секции в стопке; один компонент (PropertyStatsCard). Проверяем, что блок
 * открывается, не роняет консоль и показывает главное.
 */
test("в карточке объекта открывается «Статистика» @smoke", async ({ page }, testInfo) => {
  const { errors } = collectPageErrors(page);

  await page.goto("/properties");
  const firstRow = page.locator("[data-property-row]").first();
  const emptyCatalog = page.getByText(/объектов нет/i).first();
  await expect(firstRow.or(emptyCatalog)).toBeVisible({ timeout: 15_000 });
  if (await emptyCatalog.isVisible()) test.skip(true, "В каталоге нет объектов — проверять нечего");

  await firstRow.click();
  await expect(page).toHaveURL(/\/properties\/[^/]+$/, { timeout: 15_000 });

  // Одна карточка на ПК и телефон (06.10.2026): «Статистика» вкладка, видна только тому,
  // кто ведёт объект. Дожидаемся карточки и только потом смотрим, есть ли вкладка.
  await expect(page.getByTestId("property-card")).toBeVisible({ timeout: 15_000 });
  const tab = page.getByRole("tab", { name: "Статистика" });
  if (!(await tab.count())) test.skip(true, "Статистику видит только тот, кто ведёт объект");
  await tab.click();

  await expect(page.getByRole("heading", { name: "Путь покупателя" })).toBeVisible({ timeout: 15_000 });
  // «Соседи» намеренно выключены общим флагом NEIGHBORS_COMPARISON_ENABLED (решение
  // владельца 29.09.2026: выборка из единиц своих объектов — не рынок). Пока флаг
  // false, блока нет; вернём проверку заголовка вместе с флагом.
  await expect(page.getByRole("heading", { name: "Соседи" })).toHaveCount(0);
  await expect(page.getByLabel(/Светофор объекта/)).toBeVisible();
  await page.locator(".pst").screenshot({ path: testInfo.outputPath("property-stats.png") });

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на «Статистике» объекта:\n${errors.join("\n")}`).toEqual([]);
});
