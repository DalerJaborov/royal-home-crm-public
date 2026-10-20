import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * РАСПИСАНИЕ ВЫХОДА РОЛИКОВ (23.09.2026) — два новых экрана: вкладка
 * «Расписание» в кабинете маркетинга и своя секция в Настройках.
 *
 * Проверяется ровно то, чего не видят ни `tsc`, ни серверные тесты: экран
 * открывается, не роняет консоль и показывает ГЛАВНОЕ — время, объект и
 * причину. Тот же урок, что и у смоука: карточка объекта упала в проде при 94
 * зелёных тестах, потому что отрисовку не покрывал никто.
 */

test("вкладка «Расписание» в маркетинге открывается и объясняет часы @smoke", async ({ page }) => {
  const { errors } = collectPageErrors(page);

  await page.goto("/marketing");
  await expect(page.getByRole("heading", { name: /Маркетинг|Монтаж/ }).first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("tab", { name: /Расписание/ }).click();

  await expect(page.getByRole("heading", { name: "Расписание публикаций" })).toBeVisible({ timeout: 10_000 });
  // Главное обещание раздела: откуда взялись часы выхода. Без этой строки
  // раздел не отвечает на вопрос, ради которого заводился.
  await expect(page.getByText(/Часы выхода|Тепловая карта включена/)).toBeVisible();
  await expect(page.getByText(/Ждут своего часа/)).toBeVisible();

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на вкладке «Расписание»:\n${errors.join("\n")}`).toEqual([]);
});

/**
 * СЕКЦИИ В НАСТРОЙКАХ ЗДЕСЬ НЕТ НАМЕРЕННО. Экран настроек закрыт повторным
 * подтверждением личности («Подтвердите, что это вы», lib/stepUp.ts), и из
 * браузерного прогона он не открывается.
 * Обходить подтверждение ради проверки формы нельзя: оно и есть защита. Поля
 * секции проверены сборкой и серверными тестами границ
 * (apps/api/tests/publish-schedule-rules.test.ts).
 */

/**
 * «КАНАЛЫ РЯДОМ» ПОД ТЕПЛОВОЙ КАРТОЙ (24.09.2026) — строка на канал с полоской
 * по часам. Блок новый и рисует SVG из серверных чисел: упади он — экран
 * «Источники» потерял бы и карту, стоящую в той же ветке разметки.
 */
test("на «Источниках» под картой есть «Каналы рядом» @smoke", async ({ page }) => {
  const { errors } = collectPageErrors(page);

  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "Когда аудитория активна" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Каналы рядом" })).toBeVisible({ timeout: 10_000 });

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на «Источниках»:\n${errors.join("\n")}`).toEqual([]);
});
