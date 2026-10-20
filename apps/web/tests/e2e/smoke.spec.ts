import { test, expect } from "@playwright/test";
import { SECTIONS, CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * Smoke: каждый раздел CRM открывается и не падает.
 *
 * Это прямой ответ на продовое падение карточки объекта 26 июля: экран был
 * сломан для всех, а `tsc` и 94 серверных теста молчали, потому что проверяют
 * API, а не отрисовку. Здесь проверяется ровно то, что видит человек.
 */

for (const section of SECTIONS) {
  test(`раздел ${section.path} открывается без падения @smoke`, async ({ page }) => {
    const { errors } = collectPageErrors(page);

    await page.goto(section.path);

    // Экран отрисовался: заголовок раздела на месте. Ищем именно ЗАГОЛОВОК по
    // роли, а не любой текст: на телефоне тот же текст есть в скрытом боковом
    // меню, и поиск по тексту цеплял невидимую ссылку вместо содержимого.
    await expect(page.getByRole("heading", { name: section.heading }).first()).toBeVisible({
      timeout: 15_000,
    });

    // ErrorBoundary не сработал.
    await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);

    // И ни одной ошибки в консоли — именно так проявлялось падение хука.
    expect(errors, `ошибки на ${section.path}:\n${errors.join("\n")}`).toEqual([]);
  });
}

test("карточка объекта открывается из списка @smoke @critical", async ({ page }) => {
  // Тот самый сценарий, который упал в проде: список → карточка.
  const { errors } = collectPageErrors(page);

  await page.goto("/properties");
  const firstRow = page.locator("[data-property-row]").first();
  const emptyCatalog = page.getByText(/объектов нет/i).first();

  // Список приходит запросом, поэтому сначала ДОЖИДАЕМСЯ развязки: либо строки,
  // либо честная заглушка пустого каталога. Раньше здесь сразу читался count(),
  // и на непрогруженном списке он всегда был нулём — критический тест пропускал
  // сам себя при 148 объектах в базе, а отчёт выглядел зелёным.
  await expect(firstRow.or(emptyCatalog)).toBeVisible({ timeout: 15_000 });

  // Пустой каталог — не повод падать: у нового агентства объектов ещё нет.
  if (await emptyCatalog.isVisible()) {
    test.skip(true, "В каталоге нет объектов — проверять нечего");
  }

  await firstRow.click();
  await expect(page).toHaveURL(/\/properties\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на карточке объекта:\n${errors.join("\n")}`).toEqual([]);
});

/**
 * КАРТОЧКА КЛИЕНТА — тот же сценарий «список → карточка», что и у объекта.
 *
 * Дыра, найденная 14.08.2026: карточку ОБЪЕКТА smoke открывал (после падения в
 * проде 26 июля), а карточку КЛИЕНТА — нет. Между тем ClientDetail.tsx — самый
 * правленый экран раздела: там и статусы, и передача, и завершение сделки. Любая
 * правка в нём проходила проверку «зелёные тесты», не будучи ни разу открытой.
 */
test("карточка клиента открывается из списка @smoke @critical", async ({ page }) => {
  const { errors } = collectPageErrors(page);

  await page.goto("/clients");
  // Ссылка растянута на всю строку (Clients.tsx) — по ней и открываем, как человек.
  const firstRow = page.locator('a[aria-label^="Открыть карточку:"]').first();
  const emptyList = page.getByText(/клиентов (пока )?нет|ничего не найдено/i).first();

  // Сначала дожидаемся развязки — строка или честная заглушка. Иначе на
  // непрогруженном списке тест пропускал бы сам себя при полной базе (ровно эта
  // ошибка была у карточки объекта, см. комментарий выше).
  await expect(firstRow.or(emptyList)).toBeVisible({ timeout: 15_000 });
  if (!(await firstRow.isVisible())) {
    test.skip(true, "В списке нет клиентов — проверять нечего");
  }

  await firstRow.click();
  await expect(page).toHaveURL(/\/clients\/[^/]+$/, { timeout: 15_000 });

  // Карточка отрисовалась целиком, а не только шапка: хронология — последний
  // блок, и именно на ней ломались хуки.
  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на карточке клиента:\n${errors.join("\n")}`).toEqual([]);
});

test("переключение облика не ломает главную @smoke", async ({ page }) => {
  const { errors } = collectPageErrors(page);

  // Живой облик и классика — два разных дерева компонентов на одном маршруте.
  // Проверяем оба: раньше правки одного тихо ломали другой.
  for (const look of ["live", "classic"]) {
    await page.goto("/");
    await page.evaluate((value) => {
      const raw = JSON.parse(localStorage.getItem("royal-home-ui") ?? "{}");
      raw.state = { ...(raw.state ?? {}), look: value };
      raw.version = raw.version ?? 1;
      localStorage.setItem("royal-home-ui", JSON.stringify(raw));
    }, look);
    await page.reload();

    await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  }

  expect(errors, `ошибки при смене облика:\n${errors.join("\n")}`).toEqual([]);
});
