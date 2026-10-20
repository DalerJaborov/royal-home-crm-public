import { expect, test, type Page } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });

async function login(page: Page) {
  const target = new URL(process.env.E2E_BASE_URL ?? "http://invalid");
  expect(["localhost", "127.0.0.1"].includes(target.hostname) && !!target.port && target.port !== "5284"
    && process.env.E2E_ISOLATED_SEED === "1", "isolated seeded stand required").toBe(true);
  await page.addInitScript(() => {
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("royal-home-push-nudge-dismissed-until", String(Date.now() + 86_400_000));
  });
  await loginByCode(page, process.env.E2E_PHONE ?? "+992900000000");
}

for (const width of [1440, 390]) {
  test(`CRM-A05 nested confirm preserves forward/reverse Tab and parent focus at ${width}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/clients");
    await page.getByRole("button", { name: "Добавить клиента", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Новый клиент", exact: true });
    await form.getByLabel(/^Имя/).fill("QA keyboard draft");
    const opener = form.getByRole("button", { name: "Закрыть", exact: true });
    await opener.click();
    const confirm = page.getByRole("alertdialog", { name: "Закрыть без сохранения?", exact: true });
    const buttons = confirm.getByRole("button");
    await expect(buttons).toHaveCount(3);
    await buttons.nth(0).focus();
    for (const index of [1, 2, 0]) {
      await page.keyboard.press("Tab");
      await expect(buttons.nth(index)).toBeFocused();
    }
    for (const index of [2, 1, 0]) {
      await page.keyboard.press("Shift+Tab");
      await expect(buttons.nth(index)).toBeFocused();
    }
    await confirm.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(opener).toBeFocused();
    await form.getByLabel(/^Имя/).fill("QA keyboard draft continued");
    await opener.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(form).toHaveCount(0);
  });

  test(`CRM-A03 full update snapshots retain both selected client kinds and discard at ${width}`, async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.setViewportSize({ width, height: 1000 });
    const submitted: Record<string, unknown>[] = [];
    await page.route("**/api/v1/clients", route => {
      if (route.request().method() !== "POST") return route.fallback();
      submitted.push(route.request().postDataJSON() as Record<string, unknown>);
      // Observe the actual mutation payload; never create even a seed contact.
      if (submitted.length === 2) return route.fulfill({ status: 201, json: { id: "qa-intercepted-only", shortId: 999999, ...submitted.at(-1) } });
      return route.fulfill({ status: 409, json: { error: "QA_NO_CREATE", message: "QA intercepted create" } });
    });
    for (const [path, initial, selected, name] of [
      ["/clients", "Покупатель", "Продавец", "SELLER"],
      ["/sellers", "Продавец", "Покупатель", "BUYER"],
    ]) {
      await page.goto(path);
      await page.getByRole("button", { name: "Добавить клиента", exact: true }).click();
      let form = page.getByRole("dialog", { name: /^Новый (клиент|продавец)$/ });
      const kind = form.getByRole("group", { name: "Кто это", exact: true });
      await expect(kind.getByRole("button", { name: initial, exact: true })).toHaveAttribute("aria-pressed", "true");
      await kind.getByRole("button", { name: selected, exact: true }).click();
      // A kind-only change must already require confirmation.
      await form.getByRole("button", { name: "Закрыть", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Отмена", exact: true }).click();
      await form.getByLabel(/^Имя/).fill(`QA update ${name}`);
      await form.getByLabel(/^Телефон/).fill("000999991");
      await form.getByRole("button", { name: "Дальше", exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new Event("rh:before-app-update")));
      await page.reload();
      await page.getByRole("button", { name: "Добавить клиента", exact: true }).click();
      form = page.getByRole("dialog", { name: /^Новый (клиент|продавец)$/ });
      await expect(form.getByRole("group", { name: "Шаги формы", exact: true })
        .getByRole("button", { name: name === "SELLER" ? "Объект" : "Что ищет", exact: true })).toHaveAttribute("aria-pressed", "true");
      for (let step = 1; step < 4; step++) await form.getByRole("button", { name: "Дальше", exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new Event("rh:before-app-update")));
      await form.getByRole("button", { name: name === "SELLER" ? "Создать продавца" : "Создать клиента", exact: true }).click();
      await expect.poll(() => submitted.length).toBe(name === "SELLER" ? 1 : 2);
      expect(submitted.at(-1)).toMatchObject({ kind: name, fullName: `QA update ${name}` });
      // A saved snapshot must not return after discard or intercepted success.
      if (name === "SELLER") {
        await form.getByRole("button", { name: "Закрыть", exact: true }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Закрыть", exact: true }).click();
      } else await expect(form).toHaveCount(0);
      await page.getByRole("button", { name: "Добавить клиента", exact: true }).click();
      const fresh = page.getByRole("dialog", { name: /^Новый (клиент|продавец)$/ });
      await expect(fresh.getByLabel(/^Имя/)).toHaveValue("");
      await expect(fresh.getByRole("group", { name: "Кто это", exact: true }).getByRole("button", { name: initial, exact: true })).toHaveAttribute("aria-pressed", "true");
      await fresh.getByRole("button", { name: "Закрыть", exact: true }).click();
    }
    expect(submitted).toHaveLength(2);
  });
}
