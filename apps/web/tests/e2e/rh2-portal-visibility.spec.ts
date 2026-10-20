import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * Окна через портал (Rh2Portal/Rh2Inline) на «Главной» директора (13.09.2026).
 *
 * `MissionControlView` (Dashboard → пульт) снимает `html[data-screen]`
 * (`usePultMode`), чтобы не показывать сам пульт как отдельный экран
 * артефакта. Тем же CSS-правилом (`theme-2026-proto.css`:
 * `.rh2.screens{display:none}` / `html[data-screen] .rh2.screens{display:block}`)
 * гасилось ЛЮБОЕ окно, вынесенное порталом в `document.body` через
 * `Rh2Portal`/`Rh2Inline` — меню профиля, `ConfirmDialog`, тосты и т.д.,
 * молча: разметка на месте, элемент просто не виден. Правка —
 * `apps/web/src/components/rh2/Rh2Scope.tsx` — добавила инлайн-`display:block`
 * на обёртку портала, которая всегда перебивает правило таблицы стилей.
 *
 * Проверяем самый простой путь: главная директора → открыть меню профиля.
 */
test("меню профиля открывается на главной директора @smoke", async ({ page }, testInfo) => {
  // На телефоне шапка другая (MobileHomeHeader): кнопки «Профиль и выход» там нет,
  // профиль открывается через «Ещё». Портал один на оба, поэтому хватает ПК.
  test.skip(testInfo.project.name === "mobile", "меню профиля есть только в шапке ПК");
  const { errors } = collectPageErrors(page);

  await page.goto("/");

  const profileButton = page.getByRole("button", { name: "Профиль и выход" });
  await expect(profileButton).toBeVisible({ timeout: 15_000 });
  await profileButton.click();

  // Пункт меню «Профиль» — само меню рендерится в document.body через
  // Rh2Portal, поэтому именно оно и проверяет починку.
  await expect(page.getByRole("menuitem", { name: "Профиль" })).toBeVisible({ timeout: 5_000 });

  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на главной директора:\n${errors.join("\n")}`).toEqual([]);
});
