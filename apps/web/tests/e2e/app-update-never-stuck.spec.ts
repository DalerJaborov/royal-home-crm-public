import { expect, test } from "@playwright/test";

/**
 * «Вкладка не застревает на старой сборке» (21.11.2026, iPhone владельца: сутки
 * на старом интерфейсе, «Страница не найдена» на новом разделе).
 *
 * Сервер притворяется, что вышла новая сборка фронта (/version.json отдаёт
 * чужую версию), а перезагрузка возвращает ту же самую — ровно случай, когда
 * обновление само не применяется. Раньше после трёх попыток вкладка молча
 * оставалась на старой сборке навсегда; теперь появляется плашка
 * «Есть обновление · Обновить», и её кнопка делает полный сброс.
 *
 * Без входа: обновление обязано работать и на экране входа.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("новая version.json, а перезагрузка не помогает — плашка «Есть обновление», кнопка обновляет", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/version.json*", (route) =>
    route.fulfill({ json: { version: "e2e-next-build", builtAt: new Date().toISOString() }, headers: { "cache-control": "no-store" } })
  );

  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await page.goto("/login");
  const pill = page.locator(".rh-update-pill");
  // Лестница: перезагрузка, затем два жёстких сброса — и плашка, а не тишина.
  await expect(pill).toBeVisible({ timeout: 90_000 });
  expect(navigations).toBeGreaterThanOrEqual(3);
  await expect(pill).toContainText("Есть обновление");
  const button = pill.getByRole("button", { name: "Обновить" });
  await expect(button).toBeVisible();

  // Кнопка — полный сброс и свежая страница (адрес с меткой обхода кэша).
  const fresh = page.waitForURL(/rh-update=/, { timeout: 15_000, waitUntil: "commit" });
  await button.click();
  await fresh;
  // Сервер всё ещё «на новой сборке», окно попыток не прошло — плашка снова на месте,
  // а служебная метка из адреса убрана.
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/rh-update=/);
});
