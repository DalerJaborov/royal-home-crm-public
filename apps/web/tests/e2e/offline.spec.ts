import { test, expect } from "@playwright/test";

/**
 * Офлайн-режим: приложение открывается без сети и честно об этом говорит.
 *
 * Почему отдельным файлом и с пропуском: service worker в dev-режиме не
 * регистрируется вообще (в vite.config.ts нет devOptions), поэтому на обычном
 * прогоне проверять нечего — тест бы врал зелёным. Запускать так:
 *
 *   npm run e2e:prod --workspace=apps/web
 *
 * Проверяется ровно то, что было сломано 06.08.2026 (коммит 8d5833d): потеря
 * связи выглядела как выход из системы — упавший запрос обновления токена
 * приложение принимало за протухшую сессию и показывало экран входа.
 */

const prodBuild = process.env.E2E_PROD === "1";

test.describe("Работа без сети", () => {
  test.skip(!prodBuild, "service worker есть только в боевой сборке — запускать через e2e:prod");

  test("без сети приложение остаётся собой, а не экраном входа @offline", async ({ page, context }) => {
    // Первый заход с сетью: service worker регистрируется и кладёт оболочку в кэш.
    await page.goto("/");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });

    await context.setOffline(true);
    await page.reload();

    // Главное: НЕ выкинуло на вход. Разрыв связи — это не «вы разлогинены».
    await expect(page).not.toHaveURL(/\/login/);
    // И человек видит, что дело в связи, а не в приложении.
    await expect(page.getByText(/нет соединения/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await context.setOffline(false);
  });
});
