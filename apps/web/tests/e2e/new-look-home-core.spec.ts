import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — ядро главной для директора/админа, РОП и агента (home-core, 20.11.2026).
 *
 * Роли входят кодом стенда (LOGIN_CODE_DEV_ECHO=1, телефоны сида). Признак вида
 * подменён; ответы сервера дополнены длинными данными и графиками (настоящий ответ +
 * поля), чтобы проверить край, а не пустой экран: на девяти ширинах нет горизонтальной
 * прокрутки, ничего не вылезает за край карточки, текст с данными не режется. Плюс
 * выключатель в «Оформлении» убирает блок с главной, «Вернуть как было» возвращает,
 * а при «меньше движения» графики не анимируются.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const PHONES = { ADMIN: "+992900000001", HEAD_OF_SALES: "+992900000010", AGENT: "+992900000002" } as const;
type Role = keyof typeof PHONES;

const sessions = new Map<Role, { storageState: Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>["storageState"]>>; agent: unknown }>();

async function roleContext(browser: Browser, role: Role, baseURL: string | undefined, reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const cached = sessions.get(role) ?? await login(role);
  sessions.set(role, cached);
  const context = await browser.newContext({ baseURL, storageState: cached.storageState, serviceWorkers: "block", reducedMotion });
  await context.addInitScript((a) => {
    localStorage.setItem("royal-home-auth", JSON.stringify({ state: { agent: a, hasSession: true }, version: 1 }));
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("rh:passkey-offer-dismissed", "1");
  }, cached.agent);
  return context;
}

async function login(role: Role) {
  const api = await request.newContext({ baseURL: API });
  const headers = { "X-Device-Id": `e2e-home-core-${role.toLowerCase()}` };
  let sent = await api.post("/api/v1/auth/login/code", { data: { phone: PHONES[role] }, headers });
  for (let i = 0; i < 2 && sent.status() === 429; i++) {
    const wait = Number((await sent.json().catch(() => ({})) as { resendAfterSec?: number }).resendAfterSec ?? 60);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    sent = await api.post("/api/v1/auth/login/code", { data: { phone: PHONES[role] }, headers });
  }
  expect(sent.ok(), `код входа ${role}: ${sent.status()} ${sent.ok() ? "" : await sent.text()}`).toBe(true);
  const { pendingToken, devCode } = await sent.json() as { pendingToken: string; devCode?: string };
  expect(devCode, "стенд без LOGIN_CODE_DEV_ECHO=1").toBeTruthy();
  const verified = await api.post("/api/v1/auth/login/verify-code", { data: { pendingToken, code: devCode }, headers });
  expect(verified.ok(), `вход ${role}`).toBe(true);
  const { agent } = await verified.json() as { agent: unknown };
  const storageState = await api.storageState();
  await api.dispose();
  return { storageState, agent };
}

const NAME = "Шахризода Абдурахмонзода-Кароматуллоева";
const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const days = (n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.now() - (n - 1 - i) * 86_400_000);
  return { date: d.toISOString().slice(0, 10), leads: (i * 7) % 11 + 1, showings: i % 4 };
});
const months = () => Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11 + i, 1));
  return { month: d.toISOString().slice(0, 7), amountTjs: 12_000 + ((i * 5300) % 41_000), deals: (i % 5) + 1 };
});

/** Признак вида и данные с длинными строками и графиками — поверх настоящих ответов стенда. */
async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/dashboard/mission-control/zones", async (route) => {
    // Страница могла закрыться, пока ответ шёл: тогда подменять нечего.
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    // Ответ мог устареть, пока страница уходила на следующую ширину: тогда подменять нечего.
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!json) return;
    const marketing = (json.marketing ?? { instagramCommentsWaiting: 0, funnel: [], funnelMonth: "2026-11" }) as Record<string, unknown>;
    json.marketing = {
      ...marketing,
      funnel: [{ source: "whatsapp", label: "WhatsApp", leadsMonth: 48 }, { source: "instagram", label: "Instagram Direct и комментарии под публикациями", leadsMonth: 31 },
        { source: "site", label: "Сайт", leadsMonth: 12 }, { source: "phone", label: "Звонки", leadsMonth: 7 }]
        .map((c) => ({ showingsMonth: 1, dealsClosedMonth: 0, spendMonthTjs: null, commissionMonthTjs: null, costPerLeadTjs: null, leadsToday: 1, leadsTrailing7Avg: 1, anomalyLeadsDown: false, ...c })),
      pulse30: { reason: null, leadsTotal: 180, showingsTotal: 44, days: days(30) },
    };
    if (json.commission12 !== undefined || json.seesMoney) json.commission12 = { reason: null, months: months(), totalTjs: 312_400, bestMonth: null, expensesMonthTjs: 0 };
    await route.fulfill({ response: res, json });
  });
  await page.route((u) => u.pathname === "/api/v1/dashboard/summary", async (route) => {
    // Страница могла закрыться, пока ответ шёл: тогда подменять нечего.
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    // Ответ мог устареть, пока страница уходила на следующую ширину: тогда подменять нечего.
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!json) return;
    json.firstCallDue = [
      { id: "fc1", shortId: 9001, fullName: NAME, phone: "+992000000000", dueAt: iso(-25), afterDue: "заявка уйдёт другому агенту через десять минут, если не позвонить" },
      { id: "fc2", shortId: 9002, fullName: `${NAME} второй`, phone: "+992000000000", dueAt: iso(40) },
    ];
    json.assignedBySupervisor = [{ id: "as1", shortId: 9003, fullName: `${NAME} третий`, phone: "+992000000000", assignedAt: iso(-60), byName: "Руководитель отдела продаж Абдурахмонов" }];
    json.funnel = [{ key: "leads", label: "Новые лиды", count: 34 }, { key: "contacted", label: "На контакте", count: 21 }, { key: "showings", label: "Показы", count: 9 },
      { key: "negotiations", label: "Переговоры", count: 4 }, { key: "deals", label: "Сделки", count: 2 }];
    await route.fulfill({ response: res, json });
  });
}

const CHECK = ['[data-ry-section="home"] .ry-tile', '[data-ry-section="home"] .ry-row', '[data-ry-section="home"] .ry-section-head',
  '[data-ry-section="home"] .ry-home-chart', '[data-ry-section="home"] .ry-hero', '[data-ry-section="home"] .ry-full'].join(", ");

for (const role of Object.keys(PHONES) as Role[]) {
  test(`новый вид, ядро главной ${role}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
    test.setTimeout(360_000);
    const context = await roleContext(browser, role, baseURL);
    const page = await context.newPage();
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      // Агенту на телефоне чистая оболочка пока не включается (hooks/shellDevicePolicy.ts) — на
      // стенде её открывает местный предпросмотр, чтобы проверить ядро и на узкой ширине.
      await page.goto(role === "AGENT" ? "/?shell=clean&agentMobilePreview=1" : "/");
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator(`.ry-today[data-ry-section="home"][data-role="${role}"] .ry-section`).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Не загрузилось")).toHaveCount(0);
      // Столбики по месяцам/дням листаются внутри своей карточки (задуманная лента).
      await expectNoOverflowAt(page, width, CHECK, { strips: ".rh2-bar-chart", textRoot: '[data-ry-section="home"]' });
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  });
}

test("новый вид: выключатель в «Оформлении» убирает блок с главной, «Вернуть как было» возвращает", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(180_000);
  const context = await roleContext(browser, "AGENT", baseURL);
  const page = await context.newPage();
  await stub(page, true);
  await page.goto("/");
  await expect(page.locator('[data-block="agentMonth"] .ry-section')).toBeVisible({ timeout: 30_000 });
  await page.goto("/profile");
  await page.getByRole("tab", { name: "Вид и приложение" }).click();
  const toggle = page.getByRole("switch", { name: "Мой месяц" });
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/preferences") && r.request().method() === "PUT");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await saved).ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator('[data-block="agentTiles"] .ry-tile').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-block="agentMonth"]')).toHaveCount(0);
  // Выключено и после перезагрузки (с сервера, а не только из памяти вкладки).
  await page.evaluate(() => localStorage.removeItem("royal-home-ui"));
  await page.reload();
  await expect(page.locator('[data-block="agentTiles"] .ry-tile').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-block="agentMonth"]')).toHaveCount(0);
  await page.goto("/profile");
  await page.getByRole("tab", { name: "Вид и приложение" }).click();
  const back = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/preferences") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Вернуть как было" }).click();
  expect((await back).ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator('[data-block="agentMonth"] .ry-section')).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test("новый вид: графики растут при появлении, а при «меньше движения» — без анимации", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(180_000);
  for (const motion of ["no-preference", "reduce"] as const) {
    const context = await roleContext(browser, "AGENT", baseURL, motion);
    const page = await context.newPage();
    await stub(page, true);
    await page.goto("/");
    const bar = page.locator('[data-block="agentMonth"] .ry-home-chart .bars .b .tr i').first();
    await expect(bar).toBeVisible({ timeout: 30_000 });
    const name = await bar.evaluate((el) => getComputedStyle(el).animationName);
    expect(name, motion).toBe(motion === "reduce" ? "none" : "ry-home-fill-v");
    // После появления полоса стоит на СВОЕЙ доле (34 из 34, 21 из 34…), а не во всю ширину.
    await page.waitForTimeout(1200);
    const scales = await page.locator('[data-block="agentMonth"] .ry-home-chart .bars .b .tr i').evaluateAll((els) =>
      els.map((el) => Number((getComputedStyle(el).transform.match(/matrix\(([^,]+)/) ?? [])[1] ?? 1)));
    expect(scales[0], motion).toBeCloseTo(1, 2);
    expect(scales[1], motion).toBeCloseTo(21 / 34, 2);
    expect(scales[4], motion).toBeCloseTo(2 / 34, 2);
    await context.close();
  }
});

test("без признака у директора, РОП и агента нет ядра главной — прежние главные целы", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(240_000);
  for (const role of Object.keys(PHONES) as Role[]) {
    const context = await roleContext(browser, role, baseURL);
    const page = await context.newPage();
    await stub(page, false);
    await page.goto("/");
    await expect(page.locator("main, [role=main]").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator('[data-ry-section="home"]')).toHaveCount(0);
    await expect(page.locator(".ry-today")).toHaveCount(0);
    await context.close();
  }
});
