import { test, expect, type Page } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

// Real seed login, hermetic finance data. No expense mutation reaches the server.
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
test.beforeEach(async ({ page }, testInfo) => {
  const target = new URL(testInfo.project.use.baseURL ?? "http://invalid");
  test.skip(target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname) || !target.port || target.port === "5284" || process.env.E2E_ISOLATED_SEED !== "1", "Only an explicitly isolated local QA seed preview");
  // Validate the actual browser request recipient, including redirected API calls.
  await page.route("**/api/**", (route) => {
    const recipient = new URL(route.request().url());
    if (recipient.origin !== target.origin) return route.abort("blockedbyclient");
    return route.fallback();
  });
  await page.addInitScript(() => {
    localStorage.setItem("royal-home-device-id", "e2e-finance-expenses");
    localStorage.setItem("rh:greeting:skip", "1");
  });
  await page.route("**/api/v1/ui-shell", async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || new URL(request.url()).pathname !== "/api/v1/ui-shell") {
      return route.continue();
    }
    return route.fulfill({ json: { enabled: true } });
  });
  // Use the independently authorized admin seed session so this file does not
  // exhaust the director's real login throttle while the shell matrix runs.
  await loginByCode(page, process.env.E2E_FINANCE_PHONE ?? "+992900000001");
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function financeFixture(page: Page, count = 1, readOnly = false) {
  const month = new Date(Date.now() + 5 * 60 * 60_000).toISOString().slice(0, 7);
  const state = { amount: "300.00", deleted: false, patchCalls: [] as Record<string, unknown>[], deleteCalls: 0, failPatch: false, failDelete: false, patchGate: undefined as ReturnType<typeof deferred> | undefined, deleteGate: undefined as ReturnType<typeof deferred> | undefined };
  const row = (index: number) => ({
    id: index ? `fixture-expense-${index}` : "fixture-usd-expense", category: "OFFICE", categoryId: "00000000-0000-4000-8000-000000000001", source: null, agentId: null, agent: null,
    amount: index ? "10.00" : state.amount, currency: index ? "TJS" : "USD", exchangeRate: index ? "1" : "11", status: "PAID", paymentDate: null,
    month: `${month}-01T00:00:00.000Z`, note: index ? `Fixture ${index}` : "Fixture USD office expense", counterparty: "Fixture provider", paymentMethod: "CARD_DIRECTOR", autoKey: null, deletedAt: null,
    receipts: index ? [] : [{ id: "receipt", originalName: "fixture.pdf", mimeType: "application/pdf", size: 4, url: "/api/v1/expenses/fixture-usd-expense/receipts/receipt/file" }],
  });
  const rows = () => Array.from({ length: count }, (_, index) => row(index)).filter((_, index) => index || !state.deleted);
  const total = () => rows().reduce((sum, entry) => sum + Number(entry.amount) * (entry.currency === "USD" ? 11 : 1), 0);
  // Authentication above is the only allowed real POST. All fixture-era writes
  // must be claimed below; a newly introduced endpoint cannot mutate the seed.
  await page.route("**/api/**", (route) => route.request().method() === "GET" ? route.fallback() : route.fulfill({ status: 400, json: { error: "UNEXPECTED_FIXTURE_WRITE" } }));
  if (readOnly) await page.route("**/api/v1/me", async (route) => {
    const response = await route.fetch(); const profile = await response.json();
    return route.fulfill({ json: { ...profile, readOnly: true, permissions: ["finance.view", "messages.view"] } });
  });
  await page.route("**/api/v1/expenses**", async (route) => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname.replace("/api/v1", "");
    if (req.method() === "PATCH" && path === "/expenses/fixture-usd-expense") {
      const body = req.postDataJSON() as Record<string, unknown>; state.patchCalls.push(body); await state.patchGate?.promise;
      if (state.failPatch) return route.fulfill({ status: 403, json: { error: "FIXTURE_SAVE_DENIED" } });
      state.amount = Number(body.amount).toFixed(2); return route.fulfill({ json: row(0) });
    }
    if (req.method() === "DELETE" && path === "/expenses/fixture-usd-expense") {
      state.deleteCalls++; await state.deleteGate?.promise;
      if (state.failDelete) return route.fulfill({ status: 403, json: { error: "FIXTURE_DELETE_DENIED" } });
      state.deleted = true; return route.fulfill({ json: { ok: true } });
    }
    if (req.method() !== "GET") return route.fulfill({ status: 400, json: { error: "UNEXPECTED_FIXTURE_WRITE" } });
    if (path.endsWith("/receipts/receipt/file")) return route.fulfill({ contentType: "application/pdf", body: "%PDF" });
    if (path === "/expenses") {
      const pageNumber = Number(url.searchParams.get("page") || 1); const pageSize = Number(url.searchParams.get("pageSize") || 50);
      const selected = url.searchParams.get("month") === month || !url.searchParams.get("month") ? rows() : [];
      return route.fulfill({ json: url.searchParams.has("page") ? { items: selected.slice((pageNumber-1)*pageSize, pageNumber*pageSize), total: selected.length, page: pageNumber, pageSize } : selected });
    }
    if (path === "/expenses/categories") return route.fulfill({ json: [{ id: "00000000-0000-4000-8000-000000000001", title: "Офис", rootCategory: "OFFICE", parentId: null, icon: "building-2", color: "#5B7CFA", budgetMonthly: null, active: true, usageCount: count }] });
    if (path === "/expenses/counterparties") return route.fulfill({ json: [{ title: "Fixture provider", count, totalPaidTjs: total() }] });
    if (path === "/expenses/upcoming" || path === "/expenses/recurring") return route.fulfill({ json: [] });
    if (path === "/expenses/summary") return route.fulfill({ json: { usdToTjsRate: 11, currency: "TJS", truncated: false, months: [{ month, revenue: 0, realtorPayouts: 0, companyRevenue: 0, payouts: [], expenses: { OFFICE: total() }, totalExpenses: total(), dealSalaryExpenses: 0, operatingExpenses: total(), profit: -total(), leads: 0, costPerLead: [] }] } });
    if (path === "/expenses/forecast") return route.fulfill({ json: { month, spentTjs: total(), projectedTjs: total(), averageTjs: 0, overrun: false } });
    if (path === "/expenses/pulse") return route.fulfill({ json: { buckets: [], refreshing: false, syncedAt: null } });
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/v1/finance/forecast**", (route) => route.fulfill({ json: { month, factTjs: 0, lowTjs: 0, expectedTjs: 0, highTjs: 0, expectedCompanyTjs: 0, planTjs: 8000, percentOfPlan: 0, stages: [], paceTjs: null, workdaysLeft: 0, lowHistory: true, reasons: [] } }));
  await page.goto("/finance?shell=clean&workspace=expenses");
  const expense = page.getByRole("button", { name: `${readOnly ? "Просмотреть" : "Изменить"}: Fixture USD office expense`, exact: true });
  await expect(expense).toBeVisible();
  return { state, expense, month };
}
function sheet(page: Page) { return page.getByRole("dialog", { name: "Изменить расход", exact: true }); }

test("finance: native money navigation preserves URL, Back and reload", async ({ page }) => {
  const { state } = await financeFixture(page);
  await page.goto("/finance?shell=clean&from=dashboard&workspace=expenses");
  const nav = page.getByRole("tablist", { name: "Разделы денег" });
  await nav.getByRole("tab", { name: "Выплаты", exact: true }).click();
  await expect(page).toHaveURL(/workspace=payouts/); await expect(page).toHaveURL(/from=dashboard/);
  await expect(page.locator("#finance-panel-payouts")).toBeVisible();
  await page.goBack(); await expect(nav.getByRole("tab", { name: "Расходы", exact: true })).toHaveAttribute("aria-selected", "true");
  await nav.getByRole("tab", { name: "Подписки", exact: true }).click(); await page.reload();
  await expect(nav.getByRole("tab", { name: "Подписки", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(state.patchCalls).toEqual([]); expect(state.deleteCalls).toBe(0);
});

test("finance: USD native sheet sends one decimal PATCH and blocks duplicate pending clicks", async ({ page }) => {
  const { state, expense } = await financeFixture(page); await expense.click(); const dialog = sheet(page);
  const input = dialog.getByRole("textbox", { name: "Сумма расхода", exact: true });
  await expect(input).toHaveValue("300.00"); await expect(dialog.getByLabel("Валюта", { exact: true })).toHaveValue("USD");
  state.patchGate = deferred();
  try {
    await input.fill("300,25"); await dialog.getByRole("button", { name: "Готово", exact: true }).click();
    await expect.poll(() => state.patchCalls.length).toBe(1); await expect(input).toBeDisabled();
    const pending = dialog.getByRole("button", { name: "Сохраняем…", exact: true }); await expect(pending).toBeDisabled();
    await pending.evaluate((button: HTMLButtonElement) => button.click()); await page.keyboard.press("Enter");
    expect(state.patchCalls).toHaveLength(1); expect(state.patchCalls[0]).toMatchObject({ amount: 300.25, currency: "USD", exchangeRate: 11, paymentDate: null });
  } finally { state.patchGate.resolve(); }
  await expect(dialog).toHaveCount(0); await expect(expense).toContainText("300,25"); expect(state.patchCalls).toHaveLength(1);
});

test("finance: ambiguous thousands and failed save preserve native fields for retry", async ({ page }) => {
  const { state, expense } = await financeFixture(page); await expense.click(); const dialog = sheet(page);
  const input = dialog.getByRole("textbox", { name: "Сумма расхода", exact: true });
  await input.fill("1.000"); await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Без разделителей тысяч"); await expect(input).toBeFocused(); expect(state.patchCalls).toHaveLength(0);
  state.failPatch = true; await input.fill("301.50"); await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("FIXTURE_SAVE_DENIED"); await expect(input).toHaveValue("301.50"); await expect(input).toBeEnabled();
  state.failPatch = false; await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(expense).toContainText("301,5"); expect(state.patchCalls).toHaveLength(2);
});

test("finance: Escape asks before discarding dirty sheet without mutating", async ({ page }) => {
  const { state, expense } = await financeFixture(page); await expense.click(); const dialog = sheet(page);
  await dialog.getByRole("textbox", { name: "Сумма расхода", exact: true }).fill("999.99"); await page.keyboard.press("Escape");
  await expect(dialog.getByRole("alert")).toContainText("потерять введённые данные");
  await dialog.getByRole("button", { name: "Продолжить", exact: true }).click(); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Сумма расхода", exact: true })).toHaveValue("999.99");
  await page.keyboard.press("Escape"); await dialog.getByRole("button", { name: "Закрыть форму", exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(state.patchCalls).toHaveLength(0); expect(state.deleteCalls).toBe(0);
  await expense.click(); await expect(sheet(page).getByRole("textbox", { name: "Сумма расхода", exact: true })).toHaveValue("300.00");
});

test("finance: delete cancellation, failed retry and pending dismissal remain safe", async ({ page }) => {
  const { state, expense } = await financeFixture(page); await expense.click(); const dialog = sheet(page);
  await dialog.getByRole("button", { name: "Удалить расход", exact: true }).click(); await dialog.getByRole("button", { name: "Оставить", exact: true }).click(); expect(state.deleteCalls).toBe(0);
  state.failDelete = true; await dialog.getByRole("button", { name: "Удалить расход", exact: true }).click(); await dialog.getByRole("button", { name: "Да, удалить", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "FIXTURE_DELETE_DENIED" })).toBeVisible();
  state.failDelete = false; state.deleteGate = deferred();
  try {
    await dialog.getByRole("button", { name: "Да, удалить", exact: true }).click(); await expect.poll(() => state.deleteCalls).toBe(2);
    await expect(dialog.getByRole("button", { name: "Закрыть расход", exact: true })).toBeDisabled(); await expect(dialog.getByRole("button", { name: "Да, удалить", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Да, удалить", exact: true }).evaluate((button: HTMLButtonElement) => button.click()); expect(state.deleteCalls).toBe(2);
  } finally { state.deleteGate.resolve(); }
  await expect(dialog).toHaveCount(0); await expect(expense).toHaveCount(0); expect(state.deleteCalls).toBe(2);
});

test("finance: server pagination totals and readonly receipt details are honest", async ({ page }) => {
  const { state, expense } = await financeFixture(page, 201, true);
  await expect(page.getByText("50 из 201", { exact: true })).toBeVisible(); await expect(page.getByText("Страница 1 · всего 201", { exact: true })).toBeVisible();
  await expect(page.locator(".cef-kpi").first()).toContainText("5 300");
  await expect(page.getByRole("button", { name: "Расход", exact: true })).toHaveCount(0);
  await expense.click(); const dialog = sheet(page); await expect(dialog).toContainText("Режим просмотра");
  await expect(dialog.getByRole("button", { name: "Готово", exact: true })).toHaveCount(0); await expect(dialog.getByRole("button", { name: "Удалить расход", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "fixture.pdf", exact: true })).toBeVisible(); await expect(dialog.getByRole("textbox", { name: "Сумма расхода", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Закрыть расход", exact: true }).click();
  await page.locator(".cef-pagination").getByRole("button", { name: "Далее", exact: true }).click(); await expect(page.getByText("Страница 2 · всего 201", { exact: true })).toBeVisible();
  expect(state.patchCalls).toHaveLength(0); expect(state.deleteCalls).toBe(0);
});
