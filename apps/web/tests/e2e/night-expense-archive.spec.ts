import { test, expect, type Page } from "@playwright/test";

const EXPENSE_ID = "00000000-0000-4000-8000-000000000041";
const CONFLICT = "Расход уже изменён. Обновите запись перед удалением";
async function prepare(page: Page, readOnly = false) {
  const state = { version: 0, amount: 100, note: "Исходный расход", archived: false };
  const writes: { method: string; path: string; search: string }[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5213") { unexpected.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice("/api/v1".length);
    if (request.method() === "GET") {
      if (path === "/me") return route.fulfill({ json: { permissions: readOnly ? ["finance.view"] : ["finance.view", "finance.manage"], readOnly } });
      if (path === "/expenses/categories") return route.fulfill({ json: [] });
      if (path === "/expenses/pivot") return route.fulfill({ json: { months: [], rows: [], totalTjs: state.archived ? 0 : state.amount } });
      if (path === "/expenses") return route.fulfill({ json: {
        items: state.archived ? [] : [{ id: EXPENSE_ID, version: state.version, category: "OFFICE", amount: String(state.amount),
          currency: "TJS", amountTjs: state.amount, month: "2026-10", note: state.note, status: "PAID", paymentDate: "2026-10-10",
          source: null, agentId: null, agent: null, createdBy: { id: "synthetic-finance-actor", fullName: "Synthetic finance actor" } }],
        total: state.archived ? 0 : 1, page: 1, pageSize: 50,
      } });
    }
    if (path === `/expenses/${EXPENSE_ID}` && request.method() === "DELETE") {
      writes.push({ method: request.method(), path, search: url.search });
      // Mirror existing API compatibility: unversioned DELETE succeeds, stale version rejects.
      if (url.searchParams.has("version") && Number(url.searchParams.get("version")) !== state.version)
        return route.fulfill({ status: 409, json: { code: "EXPENSE_VERSION_CONFLICT", error: CONFLICT } });
      state.archived = true; state.version += 1;
      return route.fulfill({ status: 204 });
    }
    if (path === `/expenses/${EXPENSE_ID}/restore` && request.method() === "PATCH") {
      writes.push({ method: request.method(), path, search: url.search }); state.archived = false;
      return route.fulfill({ json: { id: EXPENSE_ID, deletedAt: null } });
    }
    unexpected.push(`${request.method()} ${path}`); return route.abort();
  });
  await page.goto(`/tests/fixtures/night-expense-archive.html?readonly=${readOnly}`);
  await expect(page.locator("tbody")).toContainText("Исходный расход");
  return { state, writes, unexpected };
}

for (const width of [1440, 390]) {
  test(`${width} stale confirmation sends captured version and preserves corrected row on 409`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { state, writes, unexpected } = await prepare(page);
    await page.getByRole("button", { name: "Удалить расход Исходный расход", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Исходный расход");
    state.version = 1; state.amount = 250; state.note = "Исправленный расход";
    await page.evaluate(() => (window as unknown as { refreshExpenseFixture: () => Promise<unknown> }).refreshExpenseFixture());
    await expect(page.locator("tbody")).toContainText("Исправленный расход");
    await expect(dialog).toContainText("Исходный расход");
    await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.poll(() => writes).toEqual([{ method: "DELETE", path: `/expenses/${EXPENSE_ID}`, search: "?version=0" }]);
    await expect(page.getByRole("alert")).toHaveText(CONFLICT);
    await expect(page.locator("tbody")).toContainText("Исправленный расход");
    expect(state).toMatchObject({ archived: false, amount: 250, version: 1 });
    await expect(page.getByRole("status").filter({ hasText: "Расход удалён" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Отменить", exact: true })).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });

  test(`${width} fresh archive succeeds and real undo restores the row`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { state, writes, unexpected } = await prepare(page);
    await page.getByRole("button", { name: "Удалить расход Исходный расход", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ method: "DELETE", path: `/expenses/${EXPENSE_ID}`, search: "?version=0" });
    await expect(page.getByRole("status").filter({ hasText: "Расход удалён" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Удалить расход Исходный расход", exact: true })).toHaveCount(0);
    expect(state.archived).toBe(true);
    await page.getByRole("button", { name: "Отменить", exact: true }).click();
    await expect(page.locator("tbody")).toContainText("Исходный расход");
    expect(state.archived).toBe(false); expect(state.amount).toBe(100);
    expect(writes.map(write => write.method)).toEqual(["DELETE", "PATCH"]);
    expect(unexpected).toEqual([]);
  });

  test(`${width} readonly role sees its row without delete or mutation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { writes, unexpected } = await prepare(page, true);
    await expect(page.getByRole("button", { name: /Удалить расход/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Посмотреть расход Исходный расход", exact: true })).toBeVisible();
    expect(writes).toEqual([]); expect(unexpected).toEqual([]);
  });
}
