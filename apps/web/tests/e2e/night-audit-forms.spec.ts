import { expect, test, type Route } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`actual deal form in mocked component fixture ${viewport.width}px`, () => {
    test.use({ viewport });

    test("pending completion keeps the form and entered amounts until a definite response", async ({ page }) => {
      let pending!: Route;
      await page.route("**/night-audit-fixture-save", route => { pending = route; });
      await page.goto("/tests/fixtures/night-audit-forms.html");
      const dialog = page.getByRole("dialog", { name: "Закрыть сделку?" });
      const inputs = dialog.getByRole("spinbutton");
      await inputs.nth(0).fill("95000");
      await inputs.nth(1).fill("1000");
      await inputs.nth(2).fill("2000");
      await dialog.getByRole("button", { name: "Закрыть сделку", exact: true }).click();
      await expect(page.getByTestId("attempts")).toHaveText("1");
      await expect(dialog.getByRole("button", { name: "Отмена", exact: true })).toBeDisabled();
      await expect(inputs.nth(0)).toBeDisabled();
      await expect(inputs.nth(1)).toBeDisabled();
      await expect(inputs.nth(2)).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "Закрыть", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect.poll(() => Boolean(pending)).toBe(true);
      await pending.fulfill({ status: 400, body: "fixture rejection" });
      await expect(dialog.getByRole("alert")).toContainText("не хватает документов");
      await expect(inputs.nth(0)).toHaveValue("95000");
      await expect(inputs.nth(1)).toHaveValue("1000");
      await expect(inputs.nth(2)).toHaveValue("2000");
      await expect(inputs.nth(0)).toBeEnabled();
      await expect(page.getByTestId("attempts")).toHaveText("1");
      await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });

    test("confirmed success closes the form once", async ({ page }) => {
      await page.route("**/night-audit-fixture-save", route => route.fulfill({ status: 200, body: "ok" }));
      await page.goto("/tests/fixtures/night-audit-forms.html");
      const dialog = page.getByRole("dialog", { name: "Закрыть сделку?" });
      await dialog.getByRole("spinbutton").nth(1).fill("1000");
      await dialog.getByRole("spinbutton").nth(2).fill("2000");
      await dialog.getByRole("button", { name: "Закрыть сделку", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("attempts")).toHaveText("1");
    });

    test("rapid load-more clicks cannot skip a slow page of deferred clients", async ({ page }) => {
      let slowPage!: Route;
      const requested: number[] = [];
      const response = (number: number) => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: `test-${number}-${i}`, fullName: `Test page ${number} row ${i}` })), total: 150, page: number, pageSize: 50 });
      await page.route("**/api/v1/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname !== "/api/v1/clients/deferred") throw new Error(`Unexpected fixture request ${url.pathname}`);
        const number = Number(url.searchParams.get("page"));
        requested.push(number);
        if (number === 2) { slowPage = route; return; }
        await route.fulfill({ json: response(number) });
      });
      await page.goto("/tests/fixtures/night-audit-forms.html?mode=deferred");
      await expect(page.getByTestId("row-count")).toHaveText("50");
      await page.getByRole("button", { name: /Показать ещё/ }).click();
      await expect.poll(() => Boolean(slowPage)).toBe(true);
      // HTMLElement.click honors disabled, and does not wait for a slow request
      // like Playwright's actionable click would. Exercise a second rapid tap.
      const more = page.getByRole("button", { name: /Показать ещё|Загружаем/ });
      await more.evaluate(button => (button as HTMLButtonElement).click());
      await slowPage.fulfill({ json: response(2) });
      await expect(page.getByTestId("row-count")).toHaveText("100");
      expect(requested).toEqual([1, 2]);
      await page.getByRole("button", { name: /Показать ещё/ }).click();
      await expect(page.getByTestId("row-count")).toHaveText("150");
      expect(requested).toEqual([1, 2, 3]);
      await expect(page.getByText("Test page 2 row 0", { exact: true })).toBeVisible();
    });

    test("actual editor dashboard keeps a slow page subscribed while its head stays visible", async ({ page }) => {
      let slowPage!: Route;
      const requested: number[] = [];
      const response = (number: number) => ({
        inEditing: Array.from({ length: 50 }, (_, i) => ({ id: `test-${number}-${i}`, shortId: `test-${number}-${i}`, title: `Test editing page ${number} row ${i}`, status: "EDITING", photoCount: 0, pipeline: { overdue: false, daysInStage: 1 } })),
        upcoming: [], counts: { inEditing: 150, overdue: 0, upcoming: 0 }, editingPage: number, upcomingPage: 1, pageSize: 50,
      });
      await page.route("**/api/v1/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname !== "/api/v1/marketing/editor-queue") throw new Error(`Unexpected fixture request ${url.pathname}`);
        const number = Number(url.searchParams.get("editingPage"));
        requested.push(number);
        if (number === 2) { slowPage = route; return; }
        await route.fulfill({ json: response(number) });
      });
      await page.goto("/tests/fixtures/night-audit-forms.html?mode=editor");
      await expect(page.getByText("Test editing page 1 row 0", { exact: true }).first()).toBeVisible();
      const more = page.getByRole("button", { name: /Показать ещё/ });
      await more.click();
      await expect.poll(() => Boolean(slowPage)).toBe(true);
      await expect(more).toBeDisabled();
      await more.evaluate(button => (button as HTMLButtonElement).click());
      await slowPage.fulfill({ json: response(2) });
      await expect(page.getByText("Test editing page 2 row 0", { exact: true })).toBeVisible();
      expect(requested).not.toContain(3);
      await more.click();
      await expect(page.getByText("Test editing page 3 row 0", { exact: true })).toBeVisible();
      expect(requested.filter(number => number > 1)).toEqual([2, 3]);
    });
  });
}
