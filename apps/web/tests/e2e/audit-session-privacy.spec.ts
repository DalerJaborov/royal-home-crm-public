import { expect, test, type Page } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

const phoneA = process.env.E2E_PHONE ?? "+992900000000";
const phoneB = process.env.E2E_SECOND_PHONE ?? "+992900000001";
test.beforeEach(() => {
  const base = new URL(process.env.E2E_BASE_URL ?? "http://invalid");
  test.skip(process.env.E2E_ISOLATED_SEED !== "1" || !["localhost", "127.0.0.1"].includes(base.hostname) || base.protocol !== "http:" || !base.port, "Requires explicit isolated seed stand");
});
async function login(page: Page, phone: string) {
  await loginByCode(page, phone);
}
async function search(page: Page) {
  // Mobile record lists expose their own local search in the header. Open the
  // global palette from Today, without replacing the genuine actor session.
  await page.goto("/");
  await page.getByRole("button", { name: "Поиск клиентов и объектов", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Поиск по CRM" });
}

for (const width of [1440, 390]) {
  test(`A04 recent search labels do not cross logout/login at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, phoneA);
    const label = "QA Private A search label";
    await page.route("**/api/v1/clients?q=*", async route => {
      const source = new URL(route.request().url());
      source.searchParams.delete("q");
      const response = await route.fetch({ url: source.toString() });
      const data = await response.json();
      expect(data.items.length, "isolated seed requires one client for search regression").toBeGreaterThan(0);
      await route.fulfill({ response, json: { ...data, items: [{ ...data.items[0], fullName: label }] } });
    });
    let palette = await search(page);
    await palette.getByPlaceholder("Имя, телефон, адрес или название раздела").fill("QA");
    await palette.getByText(label, { exact: true }).click();
    palette = await search(page);
    await expect(palette.getByText(label, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/profile");
    await page.getByRole("button", { name: /^Выйти из (CRM|аккаунта)$/ }).first().click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("royalhome:recentSearches")))).toEqual([]);
    await page.unroute("**/api/v1/clients?q=*");
    await login(page, phoneB);
    palette = await search(page);
    await expect(palette.getByText(label, { exact: true })).toHaveCount(0);
    await palette.getByPlaceholder("Имя, телефон, адрес или название раздела").fill("Клиенты");
    await palette.getByText("Клиенты", { exact: true }).last().click();
    palette = await search(page);
    await expect(palette.getByRole("heading", { name: "Недавнее" })).toBeVisible();
    await expect(palette.getByRole("button", { name: "Клиенты переход", exact: true })).toBeVisible();
    await expect(palette.getByText(label, { exact: true })).toHaveCount(0);
  });

  test(`A08 reload honors persisted idle deadline at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, phoneA);
    // Only UI preferences and activity metadata are changed locally. No tokens,
    // role or account persistence are written, and no preference PUT is sent.
    await page.route("**/api/v1/me", async route => {
      if (route.request().method() !== "GET") return route.abort();
      const response = await route.fetch(); const me = await response.json();
      await route.fulfill({ response, json: { ...me, preferences: { ...me.preferences,
        security: { ...me.preferences?.security, autoLogoutMinutes: 30 } } } });
    });
    await page.evaluate(() => {
      const ui = JSON.parse(localStorage.getItem("royal-home-ui") ?? "{}");
      localStorage.setItem("royal-home-ui", JSON.stringify({ ...ui, state: { ...ui.state, autoLogoutMinutes: 30 } }));
      const persisted = JSON.parse(localStorage.getItem("royal-home-auth") ?? "{}");
      const actorId = persisted.state.agent.id;
      localStorage.setItem(`royal-home-last-activity:${encodeURIComponent(actorId)}`, String(Date.now() - 120 * 60_000));
    });
    await page.reload();
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByLabel("Рабочий телефон")).toBeVisible();
  });
}
