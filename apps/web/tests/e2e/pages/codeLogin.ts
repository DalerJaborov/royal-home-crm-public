import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Вход и подтверждение личности по коду (пароли удалены 19.10.2026).
 *
 * Стенд запущен с LOGIN_CODE_DEV_ECHO=1 и отдаёт `devCode`: экран входа подставляет
 * его в поле сам, а для запросов без экрана код берётся из ответа сервера.
 */

/** Скрыть предложение «входить по отпечатку» — оно встало бы между кодом и главной. */
export async function skipPasskeyOffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("rh:passkey-offer-dismissed", "1");
    } catch {
      // Приватный режим — предложение просто покажется.
    }
  });
}

/** Войти через экран: номер → «Получить код» → «Подтвердить». Возвращает access-токен. */
export async function loginByCode(page: Page, phone: string): Promise<string> {
  await skipPasskeyOffer(page);
  await page.goto("/login");
  await page.getByLabel("Рабочий телефон").fill(phone);
  await page.getByRole("button", { name: "Получить код", exact: true }).click();
  const codeField = page.getByRole("textbox", { name: /Код из/ });
  await expect(codeField).toBeVisible({ timeout: 10_000 });
  await expect(codeField).toHaveValue(/^\d{6}$/, { timeout: 10_000 });
  const verified = page.waitForResponse(
    (res) => res.url().endsWith("/auth/login/verify-code") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  const response = await verified;
  expect(response.ok(), `UI login HTTP ${response.status()}`).toBe(true);
  const token: unknown = (await response.json()).accessToken;
  if (typeof token !== "string" || !token) throw new Error("Вход по коду не вернул access-токен");
  await expect(page).not.toHaveURL(/\/login/);
  return token;
}

/** Подтвердить личность запросами (без экрана): отправить код и сразу принять его. */
export async function stepUpByCode(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
  const sent = await request.post("/api/v1/auth/step-up/send-code", { headers, data: {} });
  expect(sent.ok(), `Код подтверждения HTTP ${sent.status()}`).toBe(true);
  const { devCode } = (await sent.json()) as { devCode?: string };
  if (!devCode) throw new Error("Сервер не отдал devCode: запустите API с LOGIN_CODE_DEV_ECHO=1");
  const confirmed = await request.post("/api/v1/auth/step-up", { headers, data: { code: devCode } });
  expect(confirmed.ok(), `Подтверждение личности HTTP ${confirmed.status()}`).toBe(true);
}
