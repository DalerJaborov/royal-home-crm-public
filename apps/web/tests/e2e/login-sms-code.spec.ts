import { test, expect } from "@playwright/test";

/**
 * ШАГ КОДА ПО СМС НА ЭКРАНЕ ВХОДА (23.09.2026).
 *
 * Ответы сервера подменены: реальные СМС из проверок не уходят никогда.
 * Здесь — что экран понимает ответ /auth/login/code, шлёт код на /verify-code
 * и не даёт «Отправить ещё раз» раньше срока.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("@smoke вход по коду — подсказка номера, отсчёт до повтора, код уходит на verify-code", async ({ page }) => {
  let verifiedAt: string | null = null;
  await page.route("**/api/v1/auth/login/code", (route) =>
    route.fulfill({
      json: { pendingToken: "pending", channel: "sms", phoneHint: "•• ••• 06 61", resendAfterSec: 60, telegramAvailable: true },
    })
  );
  await page.route("**/api/v1/auth/login/verify-*", (route) => {
    verifiedAt = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 401, json: { error: "Неверный код" } });
  });

  await page.goto("/login");
  await page.getByLabel("Рабочий телефон").fill("+992980001006");
  await page.getByRole("button", { name: "Получить код", exact: true }).click();

  await expect(page.getByText(/Шесть цифр из СМС на номер •• ••• 06 61/)).toBeVisible();
  // Подписи с #104 (04.11.2026): отсчёт ушёл из кнопки в строку состояния,
  // «Прислать в Telegram» стало «Через Telegram» и тоже ждёт конца отсчёта.
  // Тест тогда не обновили — @smoke краснел на исправном экране (Чат 3, 20.11).
  await expect(page.getByRole("status").filter({ hasText: /Новый код можно запросить через \d+ с/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отправить ещё раз", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Через Telegram", exact: true })).toBeDisabled();

  await page.getByRole("textbox", { name: "Код из СМС" }).fill("123456");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.getByText("Неверный код")).toBeVisible();
  expect(verifiedAt).toBe("/api/v1/auth/login/verify-code");
});
