import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * ПРАВКА НА МЕСТЕ В КАРТОЧКЕ ОБЪЕКТА (24.09.2026, пункт 17 разбора): поля,
 * документы и описание правятся прямо в просмотре — «Изменить» открывает
 * блок, «Готово» закрывает, без отдельного режима всей карточки.
 */
test("в карточке объекта поля и документы правятся на месте @smoke", async ({ page }, testInfo) => {
  const { errors } = collectPageErrors(page);

  await page.goto("/properties");
  const firstRow = page.locator("[data-property-row]").first();
  const emptyCatalog = page.getByText(/объектов нет/i).first();
  await expect(firstRow.or(emptyCatalog)).toBeVisible({ timeout: 15_000 });
  if (await emptyCatalog.isVisible()) test.skip(true, "В каталоге нет объектов — проверять нечего");

  await firstRow.click();
  await expect(page).toHaveURL(/\/properties\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByTestId("property-card")).toBeVisible({ timeout: 15_000 });

  // «Изменить» в карточке цены открывает шторку: что именно править (с 06.10.2026).
  const editMenu = page.getByTestId("property-price").getByRole("button", { name: "Изменить", exact: true });
  if (!(await editMenu.count())) test.skip(true, "У этой учётки нет права менять объект");

  await editMenu.click();
  await page.getByTestId("sheet-item-people").click();
  const done = page.getByRole("button", { name: "Готово", exact: true });
  await expect(done).toBeVisible();
  await expect(page.getByText("Видео в Instagram")).toBeVisible();
  await expect(page.getByPlaceholder("https://www.instagram.com/reel/...")).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("inline-fields.png"), fullPage: true });
  await done.click();
  await expect(done).toHaveCount(0);

  await page.getByRole("button", { name: "Отметить документы" }).click();
  await expect(page.getByRole("checkbox", { name: "Договор" })).toBeVisible();
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Договор" })).toHaveCount(0);

  // Фото: редактор во вкладке «Фото и видео», на первом экране одна галерея.
  await expect(page.getByTestId("gallery")).toHaveCount(1);
  await page.getByRole("tab", { name: /Фото и видео/ }).click();
  await page.getByRole("button", { name: "Изменить фото" }).click();
  await expect(page.getByText(/Перетащите фото|Фотографий пока нет|Загрузить/).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inline-photos.png") });
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.getByRole("button", { name: "Изменить фото" })).toBeVisible();

  // Исходники монтажёру: блока нет, если ролик уже у монтажёра или объект не для сайта.
  const sources = page.getByRole("button", { name: "Изменить исходники" });
  if (await sources.count()) {
    await sources.click();
    await expect(page.getByRole("button", { name: "Загрузить" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Готово", exact: true }).click();
    await expect(sources).toBeVisible();
  }

  // Отдельного режима правки больше нет: пункт шторки «Цена, площадь, адрес» ведёт в форму параметров.
  await editMenu.click();
  await page.getByTestId("sheet-item-params").click();
  await expect(page).toHaveURL(/\/properties\/\d+\/edit$/, { timeout: 15_000 });

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки при правке на месте:\n${errors.join("\n")}`).toEqual([]);
});
