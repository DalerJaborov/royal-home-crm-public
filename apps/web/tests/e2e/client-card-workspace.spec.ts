import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";

test.skip(process.env.E2E_CLIENT_CARD_STAND !== "1", "Requires synthetic client-card fixtures on an isolated local DB");

const sessions = new Map<string, { cookies: Awaited<ReturnType<BrowserContext["cookies"]>>; agent: unknown }>();
const phones = new WeakMap<BrowserContext, string>();
const sessionPath = (phone: string) => `playwright/.auth/client-card-${phone.slice(-3)}.json`;
test.afterEach(async ({ context }) => {
  const phone = phones.get(context), session = phone ? sessions.get(phone) : undefined;
  if (session && phone) {
    session.cookies = await context.cookies();
    fs.mkdirSync("playwright/.auth", { recursive: true });
    fs.writeFileSync(sessionPath(phone), JSON.stringify(session));
  }
});
async function login(page: Page, phone = "+992900000001") {
  phones.set(page.context(), phone);
  let session = sessions.get(phone);
  if (!session && fs.existsSync(sessionPath(phone))) {
    session = JSON.parse(fs.readFileSync(sessionPath(phone), "utf8"));
    sessions.set(phone, session!);
  }
  if (!session) {
  const headers = { "X-Device-Id": `test-client-card-${phone.slice(-3)}` };
  const sent = await page.request.post("/api/v1/auth/login/code", { headers, data: { phone } });
  expect(sent.ok(), `Code request HTTP ${sent.status()}: ${sent.ok() ? "ok" : await sent.text()}`).toBe(true);
  const { pendingToken, devCode } = await sent.json();
  expect(devCode).toMatch(/^\d{6}$/);
  const verified = await page.request.post("/api/v1/auth/login/verify-code", { headers, data: { pendingToken, code: devCode } });
  expect(verified.ok()).toBe(true);
  const issued = await verified.json();
  session = { cookies: await page.context().cookies(), agent: issued.agent };
  sessions.set(phone, session);
  } else await page.context().addCookies(session.cookies);
  await page.addInitScript(agent => {
    localStorage.setItem("royal-home-auth", JSON.stringify({ state: { agent, hasSession: true }, version: 1 }));
    localStorage.setItem("rh:passkey-offer-dismissed", "1");
  }, session.agent);
}
function futureDay(days: number) { return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10); }

test("seller: real properties, schedule, reschedule and cancel update the same showing", async ({ page }) => {
  await login(page);
  await page.goto("/clients/90001");
  await expect(page.getByRole("heading", { name: "Тестовый продавец", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Объекты продавца", exact: true }).click();
  await expect(page.locator(".client-property-line")).toHaveCount(2);
  await expect(page.getByText("Подборка этому клиенту ещё не отправлялась.")).toHaveCount(0);
  await page.locator(".client-property-entry").first().getByRole("button", { name: "Назначить показ" }).click();
  const dialog = page.getByRole("dialog", { name: "Назначить показ", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Что было")).toHaveCount(0);
  await dialog.locator('input[type="date"]').fill(futureDay(3));
  await dialog.locator('input[type="time"]').fill("13:20");
  const saved = page.waitForResponse(r => r.url().includes("/interactions") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Показы", exact: true }).click();
  await expect(page.locator(".client-property-entry").first()).toContainText("Назначен");
  await page.getByRole("button", { name: "Перенести", exact: true }).first().click();
  const move = page.getByRole("dialog", { name: "Перенести показ", exact: true });
  await move.getByLabel("Дата", { exact: true }).fill(futureDay(4));
  await move.getByLabel("Время", { exact: true }).fill("14:30");
  await move.getByLabel("Причина", { exact: true }).fill("Тестовый перенос по просьбе клиента");
  const moved = page.waitForResponse(r => r.url().includes("/showing/reschedule"));
  await move.getByRole("button", { name: "Сохранить", exact: true }).click(); expect((await moved).ok()).toBe(true);
  await expect(move).not.toBeVisible();
  await page.getByRole("button", { name: "Отменить показ", exact: true }).first().click();
  const cancel = page.getByRole("dialog", { name: "Отменить показ", exact: true });
  await cancel.getByLabel("Причина", { exact: true }).fill("Тестовая отмена по просьбе клиента");
  const cancelled = page.waitForResponse(r => r.url().includes("/showing/cancel"));
  await cancel.getByRole("button", { name: "Сохранить", exact: true }).click(); expect((await cancelled).ok()).toBe(true);
  await expect(cancel).not.toBeVisible();
  await expect(page.locator(".client-property-entry").first()).toContainText("Отменён");
});

test("buyer: full sent history paginates and network failure can recover", async ({ page }) => {
  await login(page); await page.goto("/clients/90002");
  await page.getByRole("tab", { name: "Подбор и интерес", exact: true }).click();
  await page.getByRole("button", { name: "Отправлены", exact: true }).click();
  await expect(page.locator(".client-property-entry")).toHaveCount(20);
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.locator(".client-property-entry")).toHaveCount(3);
  await page.route("**/property-activity?section=showings*", route => route.fulfill({ status: 403, json: { error: "Тестовая ошибка доступа" } }));
  await page.getByRole("button", { name: "Показы", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Не удалось загрузить объекты" })).toBeVisible();
  await page.unroute("**/property-activity?section=showings*");
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Показы", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toHaveCount(0);
});

test("completed result is recorded explicitly and closes its existing showing", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/interactions")) writes.push(request.url()); });
  await login(page); await page.goto("/clients/90002");
  await page.locator(".client-next-step").getByRole("button", { name: "Записать результат", exact: true }).click();
  const record = page.getByRole("dialog", { name: "Записать разговор с клиентом", exact: true });
  await record.getByRole("textbox", { name: "Что было", exact: true }).fill("Тестовый проведённый показ квартиры. Клиент осмотрел объект.");
  await record.getByRole("button", { name: "Далее", exact: true }).click();
  await record.getByRole("combobox", { name: "Тип", exact: true }).selectOption("SHOWING");
  const object = record.getByRole("listbox", { name: "Объект", exact: true });
  const value = await object.getByRole("option").filter({ hasText: "Тестовая квартира 1" }).getAttribute("value");
  expect(value).toBeTruthy(); await object.selectOption(value!);
  await record.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(record.getByRole("button", { name: "Сохранить", exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  const saved = page.waitForResponse(r => r.url().includes("/interactions") && r.request().method() === "POST");
  await record.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await saved).ok()).toBe(true); await expect(record).not.toBeVisible();
  await page.getByRole("tab", { name: "Подбор и интерес", exact: true }).click();
  await page.getByRole("button", { name: "Показы", exact: true }).click();
  await page.getByRole("button", { name: "Показ проведён", exact: true }).first().click();
  const confirm = page.getByRole("alertdialog", { name: "Подтвердить проведённый показ?", exact: true });
  const completed = page.waitForResponse(r => r.url().endsWith("/complete") && r.request().method() === "PATCH");
  await confirm.getByRole("button", { name: "Показ проведён", exact: true }).click();
  expect((await completed).ok()).toBe(true); await expect(confirm).not.toBeVisible();
  await expect(page.locator(".client-property-entry").first()).toContainText("Проведён");
});

test("dual intent and mobile Clean keep both directions and visible navigation", async ({ page }, info) => {
  await login(page); await page.goto("/clients/90003");
  await page.getByRole("tab", { name: "Продаёт и ищет", exact: true }).click();
  await expect(page.getByRole("button", { name: "Продаёт", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Подходят", exact: true })).toBeVisible();
  await expect(page.locator(".client-property-line")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("desktop-dual.png"), fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/clients/90003");
    await expect(page.getByRole("tab", { name: "История", exact: true })).toBeInViewport();
    await expect(page.getByRole("tab", { name: "Продаёт и ищет", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const actionRects = await page.locator('.cd-actbar .cd-act').evaluateAll(nodes => nodes.map(n => { const r=n.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }));
    for (let i=0; i<actionRects.length; i++) for (let j=i+1; j<actionRects.length; j++) {
      const a=actionRects[i], b=actionRects[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`mobile-clean-${width}.png`), fullPage: true });
  }
});

test("agent phone uses legacy with working seller workspace and conversation", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "+992900000002"); await page.goto("/clients/90001");
  await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
  await expect(page.locator(".client-property-line")).toHaveCount(2);
  await expect(page.getByText("Последний контакт", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Объекты", exact: true }).click();
  await page.screenshot({ path: info.outputPath("mobile-agent-seller.png"), fullPage: true });
  await page.getByRole("button", { name: "Написать", exact: true }).click();
  await expect(page).toHaveURL(/\/messages\?open=/);
  await expect(page.getByRole("textbox", { name: "Текст ответа", exact: true })).toBeVisible();
});

for (const [role, phone] of [["security", "+992900000003"], ["shareholder", "+992900000004"]]) {
  test(`${role}: foreign card stays read-only including conversation composer`, async ({ page }) => {
    await login(page, phone); await page.goto("/clients/90001");
    await expect(page.getByRole("button", { name: "Добавить объект", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Назначить показ", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Переписка", exact: true }).click();
    await page.getByRole("button", { name: "Открыть переписку", exact: false }).click();
    await expect(page.getByText("Режим просмотра. Отправка сообщений недоступна.", { exact: true })).toBeVisible();
    await expect(page.locator("#client-chat-reply")).toHaveCount(0);
    await page.goto("/clients/90002");
    const sendTargetRequests: string[] = [];
    page.on("request", request => { if (request.url().includes("/send-target")) sendTargetRequests.push(request.url()); });
    await page.getByRole("tab", { name: "Подбор и интерес", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Подбор/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Отправить клиенту/ })).toHaveCount(0);
    expect(sendTargetRequests).toHaveLength(0);
  });
}
