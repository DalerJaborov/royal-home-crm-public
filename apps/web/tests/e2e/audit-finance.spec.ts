import { test, expect, type Browser, type BrowserContext, type Page, type APIResponse } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

// Real writes are restricted to the dedicated, worker-disabled local seed stand.
// Tokens come only from successful UI login responses; never synthesize a session.
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });

type Session = { page: Page; context: BrowserContext; token: string; origin: string };
type Expense = { id: string; version: number; amount: string; note: string; month: string; status: string; paymentDate: string | null; categoryId: string | null };
type Template = { id: string; dayOfMonth: number; title: string; active: boolean; startsOn: string | null };

function ownOrigin(baseURL: string | undefined): string {
  const target = new URL(baseURL ?? "http://invalid");
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname) || target.port !== "5305" || process.env.E2E_ISOLATED_SEED !== "1") throw new Error("Finance mutation QA requires E2E_ISOLATED_SEED=1 and loopback :5305");
  return target.origin;
}
async function login(page: Page, origin: string): Promise<Session> {
  await page.route("**/api/**", route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort("blockedbyclient"));
  await page.addInitScript(() => {
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("royal-home-push-nudge-dismissed-until", String(Date.now() + 86_400_000));
  });
  await page.goto(`${origin}/login`);
  const token = await loginByCode(page, process.env.E2E_FINANCE_PHONE ?? "+992900000001");
  return { page, context: page.context(), token, origin };
}
async function api(session: Session, method: string, path: string, body?: unknown): Promise<APIResponse> {
  if (!/^\/expenses(?:[/?]|$)/.test(path)) throw new Error("Only expense fixture endpoints are allowed");
  const target = new URL(`/api/v1${path}`, session.origin);
  if (target.origin !== session.origin) throw new Error("Foreign API target");
  return session.page.request.fetch(target.href, { method, headers: { Authorization: `Bearer ${session.token}` }, ...(body === undefined ? {} : { data: body }), maxRedirects: 0 });
}
async function json<T>(response: Pick<APIResponse, "status" | "json">, status = 200): Promise<T> {
  expect(response.status(), `Fixture HTTP status: ${response.status()}`).toBe(status);
  return response.json() as Promise<T>;
}
async function expense(session: Session, overrides: Record<string, unknown>): Promise<Expense> {
  const day = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 7) + "-01";
  return json<Expense>(await api(session, "POST", "/expenses", { category: "OFFICE", amount: 100, currency: "TJS", note: "finance audit", month: day.slice(0, 7), paymentDate: day, status: "PAID", paymentMethod: "CASH", ...overrides }), 201);
}
async function reread(session: Session, entry: Expense): Promise<Expense> {
  const rows = await json<Expense[]>(await api(session, "GET", `/expenses?month=${entry.month.slice(0, 7)}`));
  const found = rows.find(row => row.id === entry.id);
  if (!found) throw new Error("Owned expense fixture disappeared");
  return found;
}
async function openExpense(page: Page, name: string) {
  await page.goto("/finance?workspace=expenses");
  await expect(page.locator(".clean-header")).toBeVisible();
  await page.getByRole("textbox", { name: "Поиск расходов", exact: true }).fill(name);
  await page.getByRole("button", { name: `Изменить: ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Изменить расход", exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}
async function secondSession(browser: Browser, origin: string, width: number): Promise<Session> {
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, serviceWorkers: "block" });
  try { return await login(await context.newPage(), origin); }
  catch (error) { await context.close(); throw error; }
}

for (const width of [1440, 390]) test(`finance audit A01 A02 A06 A07 genuine persistence at ${width}px`, async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const origin = ownOrigin(testInfo.project.use.baseURL);
  await page.setViewportSize({ width, height: 1000 });
  const session = await login(page, origin);
  const suffix = `audit-finance-${width}-${Date.now()}`;
  const expenseIds: string[] = [], templateIds: string[] = [], categoryIds: string[] = [];
  let other: Session | undefined;
  try {
    await test.step("A01: two real open editors reject the stale snapshot without losing its input", async () => {
      const entry = await expense(session, { note: `${suffix}-stale` }); expenseIds.push(entry.id);
      const first = await openExpense(page, entry.note);
      other = await secondSession(browser, origin, width);
      const stale = await openExpense(other.page, entry.note);
      await first.getByRole("textbox", { name: "Сумма расхода", exact: true }).fill("200");
      const firstSaved = page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/expenses/${entry.id}` && res.request().method() === "PATCH");
      await first.getByRole("button", { name: "Готово", exact: true }).click();
      expect((await firstSaved).status()).toBe(200);
      await expect(first).toBeHidden();
      await stale.getByRole("textbox", { name: "Название расхода", exact: true }).fill(`${suffix}-my retained input`);
      const rejected = other.page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/expenses/${entry.id}` && res.request().method() === "PATCH");
      await stale.getByRole("button", { name: "Готово", exact: true }).click();
      const conflict = await rejected;
      expect(conflict.status()).toBe(409);
      expect((await conflict.json()).code).toBe("EXPENSE_VERSION_CONFLICT");
      await expect(stale.getByRole("alert")).toContainText("Обновите список");
      await expect(stale.getByRole("textbox", { name: "Название расхода", exact: true })).toHaveValue(`${suffix}-my retained input`);
      await expect(stale.getByRole("textbox", { name: "Сумма расхода", exact: true })).toHaveValue(/100/);
      const stored = await reread(session, entry);
      expect(Number(stored.amount)).toBe(200); expect(stored.note).toBe(entry.note);
      await other.context.close(); other = undefined;
    });
    await test.step("A02: title-only subscription UI edits retain days 29, 30 and 31", async () => {
      const nextYear = new Date(Date.now() + 5 * 3_600_000).getUTCFullYear() + 1;
      for (const dayOfMonth of [29, 30, 31]) {
        const title = `${suffix}-subscription-${dayOfMonth}`;
        // A February occurrence is clamped but must retain the original contractual day.
        const template = await json<Template>(await api(session, "POST", "/expenses/recurring", { title, category: "OFFICE", amount: 99, currency: "TJS", period: "MONTH", startsOn: `${nextYear}-02-28`, dayOfMonth, autoPay: false }), 201); templateIds.push(template.id);
        await page.goto("/finance?workspace=recurring");
        await page.locator(".cef-sub-select").filter({ hasText: title }).click();
        const detail = page.getByRole("complementary", { name: `Подписка ${title}`, exact: true });
        await expect(detail).toBeVisible();
        if (dayOfMonth === 31) await expect(detail.locator(".cef-sub-dates")).toContainText("31 марта");
        await detail.getByRole("button", { name: "Изменить", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Изменить подписку", exact: true });
        await editor.getByRole("textbox", { name: "Название", exact: true }).fill(`${title}-renamed`);
        const saved = page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/expenses/recurring/${template.id}` && res.request().method() === "PATCH");
        await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
        const result = await json<Template>(await saved);
        expect(result.dayOfMonth).toBe(dayOfMonth); expect(result.startsOn).toBe(`${nextYear}-02-28`);
        await expect(editor).toBeHidden();
        const rows = await json<Template[]>(await api(session, "GET", "/expenses/recurring"));
        expect(rows.find(row => row.id === template.id)).toMatchObject({ title: `${title}-renamed`, dayOfMonth });
      }
    });
    await test.step("A06: real status-only future PAID request fails and preserves the stored row", async () => {
      const entry = await expense(session, { note: `${suffix}-future`, status: "PLANNED", paymentDate: "2198-02-10", month: "2198-02" }); expenseIds.push(entry.id);
      const before = await reread(session, entry);
      expect((await api(session, "PATCH", `/expenses/${entry.id}`, { version: entry.version, status: "PAID" })).status()).toBe(400);
      expect(await reread(session, entry)).toEqual(before);
    });
    await test.step("A07: existing archived assignment supports a note edit and subscription disable, new assignment fails", async () => {
      const category = await json<{ id: string }>(await api(session, "POST", "/expenses/categories", { title: `${suffix}-archived`, rootCategory: "OFFICE", icon: "Building2", color: "#4E9E88" }), 201); categoryIds.push(category.id);
      const entry = await expense(session, { note: `${suffix}-archived-expense`, categoryId: category.id }); expenseIds.push(entry.id);
      const title = `${suffix}-archived-template`;
      const template = await json<Template>(await api(session, "POST", "/expenses/recurring", { title, amount: 99, currency: "TJS", category: "OFFICE", categoryId: category.id, dayOfMonth: 15, period: "MONTH", startsOn: "2198-01-15", autoPay: false }), 201); templateIds.push(template.id);
      await json(await api(session, "PATCH", `/expenses/categories/${category.id}`, { active: false }));
      const editor = await openExpense(page, entry.note);
      await editor.getByRole("textbox", { name: "Название расхода", exact: true }).fill(`${suffix}-archived-note-corrected`);
      const saved = page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/expenses/${entry.id}` && res.request().method() === "PATCH");
      await editor.getByRole("button", { name: "Готово", exact: true }).click();
      expect((await saved).status()).toBe(200); await expect(editor).toBeHidden();
      expect(await reread(session, entry)).toMatchObject({ categoryId: category.id, note: `${suffix}-archived-note-corrected` });
      await page.goto("/finance?workspace=recurring");
      const toggle = page.getByRole("switch", { name: `Подписка «${title}» активна`, exact: true });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      const disabled = page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/expenses/recurring/${template.id}` && res.request().method() === "PATCH");
      await toggle.click(); expect((await disabled).status()).toBe(200);
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      const undo = page.locator(".toast .undo").last();
      await expect(undo).toBeVisible();
      const undoSize = await undo.boundingBox();
      expect(undoSize?.width).toBeGreaterThanOrEqual(70);
      expect(undoSize?.height).toBeGreaterThanOrEqual(44);
      expect(await undo.evaluate(node => getComputedStyle(node).whiteSpace)).toBe("nowrap");
      const toastSize = await undo.locator("..").boundingBox();
      expect(toastSize?.width).toBeGreaterThanOrEqual(Math.min(640, width - 32) - 1);
      expect(toastSize?.height).toBeLessThanOrEqual(160);
      const another = await expense(session, { note: `${suffix}-new-assignment` }); expenseIds.push(another.id);
      expect((await api(session, "PATCH", `/expenses/${another.id}`, { version: another.version, categoryId: category.id })).status()).toBe(400);
      expect((await reread(session, another)).categoryId).toBeNull();
      expect((await api(session, "POST", "/expenses", { category: "OFFICE", categoryId: category.id, amount: 10, note: `${suffix}-must-not-create`, month: "2020-02", paymentDate: "2020-02-10" })).status()).toBe(400);
    });
    await page.screenshot({ path: testInfo.outputPath(`finance-audit-${width}-after.png`), fullPage: true, animations: "disabled" });
  } finally {
    if (other) await other.context.close();
    // Public lifecycle cleanup, exact IDs only; no bulk DB writes or unrelated seed edits.
    for (const id of expenseIds.reverse()) expect((await api(session, "DELETE", `/expenses/${id}`)).status()).toBe(204);
    for (const id of templateIds.reverse()) expect((await api(session, "DELETE", `/expenses/recurring/${id}`)).status()).toBe(200);
    for (const id of categoryIds.reverse()) expect((await api(session, "PATCH", `/expenses/categories/${id}`, { active: false })).status()).toBe(200);
  }
});
