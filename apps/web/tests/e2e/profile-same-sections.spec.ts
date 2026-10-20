import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * «Мой профиль» — одни и те же возможности на ПК и на телефоне.
 *
 * До 22.09.2026 узкая ширина рисовала свой, укороченный экран: вместо блока
 * «Вход и безопасность» стояла строка-витрина «Passkey — Не подключён» без
 * единой кнопки. С телефона нельзя было ни привязать ключ входа, ни поднять
 * двухфакторную защиту, ни оборвать сессию на потерянном устройстве — а
 * последнее с телефона и делают. Ошибка молчала: сборка и тесты API такого не
 * видят, поймал прогон e2e (набор привязки ключа входа, удалённый вместе с
 * самим входом по ключу 28.09.2026, падал только на mobile).
 *
 * Тот же класс, что «Oversight/MobileOversight» в CLAUDE.md: раздельные облики
 * расходятся составом и никто не узнаёт. Поэтому проверяем не вёрстку, а
 * состав: заголовки и работающие органы управления видны на обеих ширинах.
 */
const HEADINGS = ["Личные данные", "Вход и безопасность", "Активные устройства", "История входов", "Привязки", "Вид приложения"];

test("профиль: те же разделы и кнопки на ПК и на телефоне @smoke", async ({ page }, testInfo) => {
  // Оба размера одним прогоном — как в team-member-card.spec.ts: сравниваем
  // одну и ту же страницу на разных ширинах, а не два независимых прогона.
  test.skip(testInfo.project.name !== "chromium", "оба размера проверяются одним прогоном на chromium");
  const { errors } = collectPageErrors(page);

  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/profile");

    for (const heading of HEADINGS) {
      await expect(page.getByRole("heading", { name: heading, exact: true }), `${heading} на ширине ${size.width}`).toBeVisible({
        timeout: 15_000,
      });
    }

    // Не только заголовок, но и орган управления: витрина без кнопки — ровно
    // то, что здесь и было.
    // (Вход по ключу устройства убран 28.09.2026 — проверяем кнопку 2FA.)
    await expect(
      page.getByRole("button", { name: /^(Настроить|Отключить)$/ }),
      `кнопка двухфакторной защиты на ширине ${size.width}`,
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Автовыход при неактивности"), `автовыход на ширине ${size.width}`).toBeVisible();

    await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  }

  expect(errors, "консоль должна быть чистой").toEqual([]);
});
