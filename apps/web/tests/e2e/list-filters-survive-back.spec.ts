import { test, expect } from "@playwright/test";

/**
 * Отбор в списке переживает поход в карточку и обратно.
 *
 * Разбор интерфейса 13.08.2026: фильтры жили только в памяти компонента. Агент
 * отбирал квартиры, открывал объект, нажимал «назад» — и получал весь список
 * заново, с первой страницы и без единого условия. После каждого просмотренного
 * объекта отбор приходилось собирать сначала; на телефоне, где в экран влезает
 * пять строк, это была самая дорогая мелочь в CRM.
 *
 * Проверяем цепочку целиком: выбрал → условие в адресе → открыл карточку ССЫЛКОЙ
 * (а не onClick: строка обязана быть ссылкой) → назад → условие на месте.
 */
test("фильтр объектов остаётся после возврата из карточки @smoke", async ({ page }) => {
  await page.goto("/properties");

  // Тема 2026: фильтры живут в шторке эталона (`.sheet.right`) и открываются
  // кнопкой «Фильтры» — и на десктопе, и на телефоне (Properties.tsx,
  // MobilePropertiesList.tsx). Раньше поля стояли прямо над списком.
  await page.getByRole("button", { name: /^Фильтры/ }).first().click();
  const typeFilter = page.getByLabel("Тип объекта");
  await expect(typeFilter).toBeVisible();
  await typeFilter.selectOption("APARTMENT");

  // Условие уехало в адрес — значит списком можно поделиться и вернуться к нему.
  await expect(page).toHaveURL(/type=APARTMENT/);
  // Шторка остаётся открытой и её подложка перехватывает клики — закрываем, как человек.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Фильтры объектов" })).toBeHidden();

  // Строка списка — настоящая ссылка: растянутая на всю строку (PropertyRow.tsx),
  // она лежит поверх текста и её же нажимает человек в любом месте строки.
  //
  // Две разметки, и обе живые (19.09.2026): на компьютере ссылка лежит ВНУТРИ
  // строки, на телефоне ссылкой является сама строка
  // (components/mobile/MobilePropertiesList.tsx). Раньше искали только вложенную
  // — и телефонный проход падал на исправном каталоге.
  const firstRow = page
    .locator('[data-property-row] a[aria-label^="Открыть объект:"], a[data-property-row][aria-label^="Открыть объект:"]')
    .first();
  await expect(firstRow).toHaveAttribute("href", /\/properties\/\d+/);
  await firstRow.click();
  await expect(page).toHaveURL(/\/properties\/\d+/);

  await page.goBack();

  // Главное: вернулись к ТОМУ ЖЕ списку, а не к пустому.
  await expect(page).toHaveURL(/type=APARTMENT/);
  await page.getByRole("button", { name: /^Фильтры/ }).first().click();
  await expect(page.getByLabel("Тип объекта")).toHaveValue("APARTMENT");
});
