import { test, expect, type Page } from "@playwright/test";
const id = "00000000-0000-4000-8000-000000000051";
const conflict = "Расход уже изменён. Обновите запись перед удалением";
async function prepare(page: Page, readOnly = false) {
  const state = { version: 0, amount: 100, note: "Исходный расход", archived: false };
  const writes: { method: string; path: string; search: string }[] = [], unexpected: string[] = [];
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:5215") return route.abort();
    if (!url.pathname.startsWith("/api/v1/")) return route.continue();
    const path = url.pathname.slice("/api/v1".length);
    if (request.method() === "GET") {
      if (path === "/me") return route.fulfill({ json: { permissions: readOnly ? ["finance.view"] : ["finance.view", "finance.manage"], readOnly } });
      if (path === "/settings") return route.fulfill({ json: { usdToTjsRate: "10" } });
      if (path === "/ui-shell") return route.fulfill({ json: { enabled: false } });
      if (path === "/agents") return route.fulfill({ json: [] });
      if (path === "/expenses/forecast") return route.fulfill({ json: { month: "2026-10", averageTjs: 0, projectedTjs: 0 } });
      if (path === "/expenses") return route.fulfill({ json: state.archived ? [] : [{ id, version: state.version, amount: String(state.amount), note: state.note, category: "OFFICE", currency: "TJS", month: "2026-10", source: null, agentId: null, agent: null, autoKey: null }] });
    }
    if (path === `/expenses/${id}` && request.method() === "DELETE") {
      writes.push({ method: request.method(), path, search: url.search });
      // Mirror the independently verified API's existing optional-version CAS.
      if (url.searchParams.has("version") && Number(url.searchParams.get("version")) !== state.version)
        return route.fulfill({ status: 409, json: { code: "EXPENSE_VERSION_CONFLICT", error: conflict } });
      state.archived = true; state.version += 1; return route.fulfill({ status: 204 });
    }
    unexpected.push(`${request.method()} ${path}`); return route.abort();
  });
  await page.goto(`/tests/fixtures/night-expense-workspace.html?readonly=${readOnly}`);
  await expect(page.getByText("Офис, Исходный расход", { exact: true })).toBeVisible();
  return { state, writes, unexpected };
}
for (const width of [1440, 390]) {
  test(`${width} stale confirmation sends its opening version despite a real query refetch`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 }); const { state, writes, unexpected } = await prepare(page);
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    const dialog = page.getByRole("alertdialog"); await expect(dialog).toBeVisible();
    state.amount = 250; state.version = 1; state.note = "Исправленный расход";
    await page.evaluate(() => (window as unknown as { refreshWorkspaceExpenses: () => Promise<unknown> }).refreshWorkspaceExpenses());
    await expect(page.getByText("Офис, Исправленный расход", { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await info.attach("actual-workspace-delete.json", { body: JSON.stringify({ opening: { amount: 100, version: 0 }, writes, state }, null, 2), contentType: "application/json" });
    expect(writes).toEqual([{ method: "DELETE", path: `/expenses/${id}`, search: "?version=0" }]);
    await expect(dialog.getByRole("alert")).toHaveText(conflict);
    await expect(page.getByText("Офис, Исправленный расход", { exact: true })).toBeVisible();
    expect(state).toMatchObject({ archived: false, amount: 250, version: 1 }); expect(unexpected).toEqual([]);
  });
  test(`${width} fresh archive remains successful`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const { state, writes, unexpected } = await prepare(page);
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByText("За этот месяц расходов нет.", { exact: false })).toBeVisible();
    expect(writes[0]).toMatchObject({ method: "DELETE", path: `/expenses/${id}` });
    expect(state).toMatchObject({ archived: true, amount: 100, version: 1 }); expect(unexpected).toEqual([]);
  });
  test(`${width} read-only workspace exposes no archive action or mutation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const { writes, unexpected } = await prepare(page, true);
    await expect(page.getByRole("button", { name: "Удалить", exact: true })).toHaveCount(0); expect(writes).toEqual([]); expect(unexpected).toEqual([]);
  });
}
