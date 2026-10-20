import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { ROLE_LABELS, type UiShellRollout, type UiShellRolloutConfig } from "@royal-home/shared";
import type { McLive } from "../../src/hooks/useMissionControl";
import { SECTIONS } from "./pages/crm.page";
import { stepUpByCode } from "./pages/codeLogin";
const accessTokens = new WeakMap<object, string>();
const seedSessions = new Map<string, { cookies: Awaited<ReturnType<BrowserContext["cookies"]>>; authStorage: string }>();
const contextPhones = new WeakMap<BrowserContext, string>();

test("clean: phone expense table contains long category controls inside the viewport", async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/expenses/categories", async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    const categories = await response.json();
    expect(Array.isArray(categories) && categories.length > 0).toBe(true);
    await route.fulfill({ json: categories.map((item: { title: string }, index: number) => index === 0
      ? { ...item, title: "Длинная категория для проверки ширины фильтра ".repeat(4) } : item) });
  });
  await page.goto("/finance?workspace=table");
  const original = await page.locator("html").getAttribute("data-theme");
  const selectTheme = async (value: string) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== value) {
      const saved = page.waitForResponse(res => res.url().endsWith("/me/preferences") && res.request().method() === "PUT");
      await page.locator("[data-topbar-theme]:visible").first().click(); expect((await saved).ok()).toBe(true);
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  };
  try { for (const theme of ["light", "night"]) {
    await selectTheme(`royal-home-2026-${theme}`);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const filters = page.locator(".cef-table-filters"); await expect(filters).toBeVisible();
      await expect(filters.getByRole("option", { name: /^Длинная категория/ })).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const controls = await filters.locator("input,select").evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right };
      }));
      expect(controls).toHaveLength(5);
      for (const control of controls) { expect(control.left).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(width + 1); }
      // Keep the wide data table scrollable inside its own region.
      const scroll = page.locator(".cef-table-scroll");
      await expect(scroll).toBeVisible();
      await expect(scroll).toHaveCSS("overflow-x", "auto");
    }
  } } finally { if (original) await selectTheme(original); }
});

async function retainSeedSession(page: Page, phone: string) {
  const authStorage = await page.evaluate(() => localStorage.getItem("royal-home-auth"));
  if (authStorage) seedSessions.set(phone, { cookies: await page.context().cookies(), authStorage });
  else seedSessions.delete(phone);
}

for (const width of [1440, 390]) test(`Clean channel detail preserves snapshot states and Back at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  const name = "Демо % / канал";
  let ok: boolean | null = null;
  let failed = false;
  await page.route("**/api/v1/integrations", (route) => route.fulfill(failed ? { status: 500, json: { error: "QA_SNAPSHOT_UNAVAILABLE" } } : {
    json: { channels: [{ name, ok, detail: ok === true ? "Соединение доступно" : ok === false ? "Истёк доступ" : "Доступ не выдан", checkedAt: "2026-10-17T08:00:00Z" }] },
  }));
  await page.goto("/integrations?source=qa");
  await page.getByRole("button", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  const detail = page.locator(".clean-channel-detail");
  await expect(detail.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await expect(detail.locator(".mh")).toHaveCount(0);
  await expect(detail.getByText("Не настроен", { exact: true })).toBeVisible();
  for (const [value, label] of [[false, "Есть ошибка"], [true, "Работает"]] as const) {
    ok = value;
    await detail.getByRole("button", { name: "Обновить снимок", exact: true }).click();
    await expect(detail.getByText(label, { exact: true })).toBeVisible();
  }
  failed = true;
  await detail.getByRole("button", { name: "Обновить снимок", exact: true }).click();
  // Preserve the application's real transient-error retry policy (up to four retries).
  await expect(detail.getByRole("alert")).toContainText("последние доступные данные", { timeout: 25_000 });
  failed = false;
  await detail.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  if (width < 820) await page.getByRole("button", { name: "Назад", exact: true }).click();
  else await detail.getByRole("button", { name: "Назад к списку каналов", exact: true }).click();
  await expect(page).toHaveURL(/\/integrations\?source=qa$/);
});

test.describe("Clean touch marketing", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  test("Clean pipeline uses the shared record with its stage caption on a phone", async ({ page }) => {
    await login(page);
    await page.goto("/pipeline");
    const records = page.locator('main [data-property-layout="row"]');
    await expect(records.first()).toBeVisible();
    await expect(records.first().locator(".clean-property-subline")).not.toHaveText("");
    await expect(records.first().locator(".pstats")).toHaveCSS("display", "flex");
    await expect(records.first().locator(".pstat").first()).toHaveCSS("display", /^(inline-)?flex$/);
    await expect(records.first().locator(".pstat").first()).toHaveCSS("column-gap", "5px");
    await expect.poll(() => records.first().locator(".pstat").first().evaluate(node => {
      const value = node.querySelector("b")!.getBoundingClientRect();
      const label = node.querySelector("small")!.getBoundingClientRect();
      return label.left - value.right;
    })).toBeGreaterThanOrEqual(4);
    await expect(records.first().getByRole("link", { name: /^Открыть объект:/ })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(390);
    await page.getByRole("tablist", { name: "Фильтр конвейера", exact: true }).getByRole("tab", { name: /^Все объекты/ }).click();
    await expect(records.first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(390);
  });
  test("Clean currency settings keep every action inside the phone viewport", async ({ page }) => {
    await login(page);
    await elevatedHeaders(page);
    await page.goto("/settings?tab=money&task=currency");
    const update = page.getByRole("button", { name: "Обновить с alif.tj", exact: true });
    await expect(update).toBeVisible();
    await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(390);
    await expect.poll(() => update.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= 390;
    })).toBe(true);
  });
  test("Clean marketing queue keeps stages tappable inside the phone viewport", async ({ page }) => {
    await login(page);
    await page.goto("/marketing?tab=queue");
    const stages = page.getByRole("tablist", { name: "Стадии конвейера", exact: true });
    await expect(stages).toBeVisible();
    await expect(page.locator("main .prow > .act").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ width: 390, document: 390 });
    for (const tab of await stages.getByRole("tab").all()) {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(390);
    }
    const root = page.getByRole("tablist", { name: "Что показывать", exact: true });
    await root.getByRole("tab", { name: "Сайт и поиск", exact: true }).click();
    await root.getByRole("tab", { name: "Очередь подготовки", exact: true }).click();
    await stages.getByRole("tab").first().click();
    await expect(stages.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  });
});

for (const width of [1440, 390]) test(`Clean primary buttons retain their variant inside legacy scope at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/deals");
  const create = page.getByRole("button", { name: "Новая сделка", exact: true });
  await expect(create).toBeVisible();
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  const selectTheme = async (value: string) => {
    if (await page.locator("html").getAttribute("data-theme") === value) return;
    await page.setViewportSize({ width: 1440, height: 1000 });
    const saved = page.waitForResponse((res) => res.url().endsWith("/me/preferences") && res.request().method() === "PUT");
    await page.locator("[data-topbar-theme]:visible").first().click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  };
  try { for (const theme of ["light", "night"]) {
    await selectTheme(`royal-home-2026-${theme}`);
    await page.setViewportSize({ width, height: 1000 });
    const style = await create.evaluate((node) => {
    const value = getComputedStyle(node);
    const channels = value.backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map((channel) => {
      const linear = Number(channel) / 255;
      return linear <= .04045 ? linear / 12.92 : ((linear + .055) / 1.055) ** 2.4;
    });
    const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    return { background: value.backgroundColor, color: value.color, shadow: value.boxShadow, contrast: 1.05 / (luminance + .05) };
  });
  expect(style.background).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
  expect(style.color).toBe("rgb(255, 255, 255)");
  expect(style.shadow).toBe("none");
  expect(style.contrast).toBeGreaterThanOrEqual(4.5);
  }} finally { if (originalTheme) await selectTheme(originalTheme); }
});

test("Clean team puts the roster before optional recognition on a phone", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/team");
  const recognition = page.locator(".clean-team-recognition");
  await expect(recognition).toBeVisible();
  await expect(recognition).not.toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { name: "Вся команда", exact: true })).toBeVisible();
  await recognition.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(recognition).toHaveAttribute("open", "");
  await expect(recognition.getByRole("heading", { name: "Доска почёта", exact: true })).toBeVisible();
});

for (const width of [1440, 390]) test(`Clean section order preserves all workspace destinations at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const journeys = [
    { from: "/calls", to: "/messages", label: /^Сообщения/ },
    { from: "/team", to: "/activity", label: /^Активность команды/ },
    { from: "/ads", to: "/social-videos", label: "Ролики в соцсети" },
    { from: "/settings", to: "/backups", label: "Резервные копии" },
    { from: "/reports", to: "/sources", label: "Источники лидов" },
  ];
  for (const journey of journeys) {
    await page.goto(journey.from);
    const nav = page.getByRole("navigation", { name: "Разделы экрана", exact: true }).first();
    await expect(nav).toBeVisible();
    await page.evaluate(() => { (window as Window & { __sectionDocument?: string }).__sectionDocument = "section-order"; });
    if (width < 820) {
      const picker = nav.getByRole("combobox", { name: "Перейти в раздел", exact: true });
      await expect(picker).toBeVisible();
      await expect(picker).toHaveValue(journey.from);
      await picker.selectOption(journey.to);
    } else {
      await expect(nav.getByRole("combobox")).toHaveCount(0);
      await nav.getByRole("link", { name: journey.label }).click();
    }
    await expect.poll(() => new URL(page.url()).pathname).toBe(journey.to);
    expect(await page.evaluate(() => (window as Window & { __sectionDocument?: string }).__sectionDocument)).toBe("section-order");
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe(journey.from);
  }
});

for (const width of [1440, 390]) test(`Clean object keeps deal creation compact and keyboard-accessible at ${width}px`, async ({ page }) => {
  await login(page);
  await page.goto("/properties/19");
  const original = await page.locator("html").getAttribute("data-theme");
  let creates = 0;
  await page.route("**/api/v1/deals", route => {
    if (route.request().method() !== "POST") return route.fallback();
    creates += 1; return route.fulfill({ status: 409, json: { error: "QA_NO_CREATE" } });
  });
  try { for (const theme of ["light", "night"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== `royal-home-2026-${theme}`) await page.locator("[data-topbar-theme]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", `royal-home-2026-${theme}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const card = page.locator("details#deal-assign");
    await expect(card).toHaveJSProperty("open", false);
    await expect(card.getByLabel("Поиск покупателя", { exact: true })).toBeHidden();
    const summary = card.locator("summary");
    await summary.focus(); await summary.press("Enter");
    await expect(card).toHaveJSProperty("open", true);
    await card.getByLabel("Поиск покупателя", { exact: true }).fill("Демо");
    await expect(card.getByLabel("Поиск покупателя", { exact: true })).toBeVisible();
    await expect(card.locator("select")).toBeEnabled();
    await summary.focus(); await summary.press("Enter");
    await expect(card).toHaveJSProperty("open", false);
    await expect(card.getByLabel("Поиск покупателя", { exact: true })).toBeHidden();
  }} finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== original) await page.locator("[data-topbar-theme]:visible").first().click();
  }
  expect(creates).toBe(0);
});

for (const width of [1440, 390]) test(`Clean dialer stays opaque and separates key labels at ${width}px`, async ({ page }) => {
  await login(page);
  await page.goto("/calls");
  const original = await page.locator("html").getAttribute("data-theme");
  let dialRequests = 0;
  page.on("request", request => {
    if (request.method() === "POST" && /\/dial(?:\?|$)/.test(request.url())) dialRequests += 1;
  });
  try { for (const theme of ["light", "night"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== `royal-home-2026-${theme}`) await page.locator("[data-topbar-theme]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", `royal-home-2026-${theme}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.getByRole("button", { name: "Набрать номер", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Набор номера", exact: true });
    await expect(dialog).toBeVisible();
    const metrics = await dialog.evaluate(node => {
      const color = getComputedStyle(node).backgroundColor;
      return {
        alpha: color.startsWith("rgba") ? Number(color.match(/[\d.]+/g)!.at(-1)) : color === "transparent" ? 0 : 1,
        gaps: [...node.querySelectorAll("button.aspect-square")].map(key => {
          const spans = key.querySelectorAll("span");
          return spans[1].getBoundingClientRect().top - spans[0].getBoundingClientRect().bottom;
        }),
        contained: node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().bottom <= innerHeight + 1,
      };
    });
    expect(metrics.alpha).toBeGreaterThanOrEqual(.99);
    expect(metrics.contained).toBe(true);
    expect(metrics.gaps).toHaveLength(12);
    for (const gap of metrics.gaps) expect(gap).toBeGreaterThanOrEqual(3.5);
    await dialog.getByRole("button", { name: "Закрыть наборщик", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }} finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== original) await page.locator("[data-topbar-theme]:visible").first().click();
  }
  expect(dialRequests).toBe(0);
});

test("Clean read-only account does not send forbidden presence or event-ticket writes", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/v1\/(?:_seen|events\/ticket|dashboard\/counters\/seen)$/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  await login(page, "+992900000009");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [route, title] of [["/finance", "Деньги"], ["/clients", "Клиенты"]]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
    }
    await expect(page.locator(".clean-header")).toBeVisible();
  }
  expect(writes).toEqual([]);
});

test("Clean client quick actions fit narrow phones without hiding an action", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await page.goto("/clients");
  const links = page.locator('main a[href]');
  await expect.poll(() => links.evaluateAll(nodes => nodes.filter(node => /^\/clients\/(?:\d+|[\da-f-]{36})$/.test(node.getAttribute("href") ?? "")).length)).toBeGreaterThan(0);
  const href = await links.evaluateAll(nodes => nodes.find(node => /^\/clients\/(?:\d+|[\da-f-]{36})$/.test(node.getAttribute("href") ?? ""))?.getAttribute("href"));
  await page.goto(href!);
  await expect(page.locator(".clean-client-detail h1")).toBeVisible();
  const original = await page.locator("html").getAttribute("data-theme");
  const selectTheme = async (theme: string) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      const saved = page.waitForResponse(response => response.url().endsWith("/me/preferences") && response.request().method() === "PUT");
      await page.locator("[data-topbar-theme]:visible").first().click();
      expect((await saved).ok()).toBe(true);
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  };
  try { for (const theme of ["light", "night"]) {
    await selectTheme(`royal-home-2026-${theme}`);
    for (const width of [1440, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 1000 });
      const actions = page.locator(".cd-actbar .cd-act").filter({ visible: true });
      await expect(actions).toHaveCount(width < 768 ? 4 : 0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const metrics = await actions.evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height, width: rect.width, client: document.documentElement.clientWidth };
      }));
      for (const metric of metrics) {
        expect(metric.left).toBeGreaterThanOrEqual(0);
        expect(metric.right).toBeLessThanOrEqual(metric.client + 1);
        expect(metric.height).toBeGreaterThanOrEqual(44);
        expect(metric.width).toBeGreaterThanOrEqual(44);
      }
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      await page.screenshot({ path: testInfo.outputPath(`client-actions-${width}-${theme}.png`), fullPage: true });
    }
  }
    // The multi-number chooser is a direct child; a single-number call button
    // has a relative wrapper. Exercise both real component branches without
    // writing a phone number to the seed database or making a call.
    await page.route(/\/api\/v1\/clients\/[^/?]+(?:\?.*)?$/, async route => {
      if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== `/api/v1${href}`) return route.fallback();
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      const client = await response.json();
      await route.fulfill({ json: { ...client, whatsappPhone: "+992900000099" } });
    });
    await page.reload();
    for (const theme of ["light", "night"]) {
      await selectTheme(`royal-home-2026-${theme}`);
      await page.setViewportSize({ width: 360, height: 1000 });
      const directActions = page.locator(".cd-actbar > .cd-act").filter({ visible: true });
      await expect(directActions).toHaveCount(4);
      const bounds = await directActions.evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height, width: rect.width, client: document.documentElement.clientWidth };
      }));
      for (const rect of bounds) { expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(rect.client + 1); expect(rect.height).toBeGreaterThanOrEqual(44); expect(rect.width).toBeGreaterThanOrEqual(44); }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    await page.goto("/finance?workspace=table");
    await expect(page.getByText("Таблица учитывает расходы с указанной датой платежа. Записи, где известен только месяц, смотрите во вкладке «Расходы».", { exact: true })).toBeVisible();
    await expect(page.locator('.cef-table [aria-busy="true"]')).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      await page.screenshot({ path: testInfo.outputPath(`money-table-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally { if (original) await selectTheme(original); }
});

test("Clean mobile detail keeps the client's identifying heading visible", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/clients");
  const firstClient = page.locator('main a[href]').filter({ visible: true });
  await expect.poll(async () => firstClient.evaluateAll((links) => links.filter((link) => /^\/clients\/(?:\d+|[\da-f-]{36})$/.test(link.getAttribute("href") ?? "")).length)).toBeGreaterThan(0);
  const href = await firstClient.evaluateAll((links) => links.find((link) => /^\/clients\/(?:\d+|[\da-f-]{36})$/.test(link.getAttribute("href") ?? ""))?.getAttribute("href"));
  expect(href).toBeTruthy();
  await page.goto(href!);
  await expect(page.locator(".clean-client-detail h1")).toBeVisible();
  await expect.poll(() => page.locator(".clean-client-detail h1").evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(80);
  await expect(page.locator(".clean-client-detail h1")).toHaveCSS("white-space", "normal");
  await expect(page.getByRole("tabpanel")).not.toHaveText("");
  await expect.poll(() => page.getByRole("tab", { name: "Обзор", exact: true }).evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(12);
  let writes = 0;
  await page.route("**/api/v1/clients/**", route => {
    if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.fallback();
    writes += 1; return route.fulfill({ status: 409, json: { error: "QA_NO_MUTATION" } });
  });
  await page.locator(".clean-client-detail").getByRole("button", { name: "Ещё", exact: true }).click();
  const more = page.getByRole("dialog", { name: "Ещё", exact: true });
  await expect(more).toBeVisible();
  await more.getByRole("button", { name: "Изменить данные", exact: true }).click();
  await expect(more).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Изменить клиента", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  expect(writes).toBe(0);
});

for (const width of [1440, 390]) test(`Clean client wizard stays opaque through every step at ${width}px`, async ({ page }, testInfo) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/clients");
  let creates = 0;
  await page.route("**/api/v1/clients", route => {
    if (route.request().method() !== "POST") return route.fallback();
    creates += 1; return route.fulfill({ status: 409, json: { error: "QA_NO_CREATE" } });
  });
  const original = await page.locator("html").getAttribute("data-theme");
  const selectTheme = async (theme: string) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-topbar-theme]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  };
  try { for (const theme of ["light", "night"]) {
    await selectTheme(`royal-home-2026-${theme}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.getByRole("button", { name: "Добавить клиента", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новый клиент", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^Имя/).fill("QA · Проверка формы");
    await dialog.getByLabel(/^Телефон/).fill("000999991");
    for (const step of ["Контакты", "Что ищет", "Бюджет", "Подробности", "Проверьте"]) {
      await expect(dialog.getByRole("group", { name: "Шаги формы", exact: true }).getByRole("button", { name: step, exact: true })).toHaveAttribute("aria-pressed", "true");
      const surface = await dialog.evaluate(node => {
        const background = getComputedStyle(node).backgroundColor;
        const alpha = background.startsWith("rgba") ? Number(background.match(/[\d.]+/g)!.at(-1)) : background === "transparent" ? 0 : 1;
        return { alpha, overflow: node.scrollWidth > node.clientWidth + 1 };
      });
      expect(surface.alpha).toBeGreaterThanOrEqual(.99);
      expect(surface.overflow).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`wizard-${theme}-${step}.png`) });
      if (step !== "Проверьте") await dialog.getByRole("button", { name: "Дальше", exact: true }).click();
    }
    await expect(dialog.getByRole("button", { name: "Создать клиента", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Закрыть без сохранения?", exact: true }).getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }} finally { if (original) await selectTheme(original); }
  expect(creates).toBe(0);
});

for (const width of [360, 390]) test(`Clean response-speed labels stay inside each phone column at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/sources");
  const labels = page.locator(".rsp-bars .rsp-n");
  await expect(labels).toHaveCount(6);
  await expect.poll(() => labels.evaluateAll(nodes => nodes.every(node => {
    const box = node.getBoundingClientRect(), column = node.closest(".rsp-col")!.getBoundingClientRect();
    return node.scrollWidth <= node.clientWidth + 1 && box.left >= column.left - 1 && box.right <= column.right + 1;
  }))).toBe(true);
});

test("Clean fallback avatars remain readable in both themes", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Нужны ваши решения", exact: true })).toBeVisible();
  const original = await page.locator("html").getAttribute("data-theme");
  const selectTheme = async (theme: string) => {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-topbar-theme]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  };
  try { for (const theme of ["light", "night"]) {
    await selectTheme(`royal-home-2026-${theme}`);
    const avatars = page.locator("main .clean-avatar-fallback");
    await expect(avatars.first()).toBeVisible();
    const contrasts = await avatars.evaluateAll(nodes => nodes.map(node => {
      const s = getComputedStyle(node);
      const luminance = (color: string) => {
        const c = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
          const x = Number(value) / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
        });
        return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
      };
      const foreground = luminance(s.color), background = luminance(s.backgroundColor);
      return { image: s.backgroundImage, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
    }));
    for (const contrast of contrasts) { expect(contrast.image).toBe("none"); expect(contrast.ratio).toBeGreaterThanOrEqual(4.5); }
  }} finally { if (original) await selectTheme(original); }
});

for (const width of [1440, 390]) test(`Clean property offers wait for a known send target at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  let failed = true;
  let sends = 0;
  await page.route("**/api/v1/clients/*/send-target**", route => route.fulfill(failed
    ? { status: 500, json: { error: "QA_TARGET_UNAVAILABLE" } }
    : { json: { channel: "WHATSAPP", channelEnabled: false, windowOpen: false, lastClientMessageAt: null, smsAvailable: false, hint: "Демонстрационный канал выключен. Можно подготовить ссылку." } }));
  await page.route("**/api/v1/clients/*/send-properties", route => { sends += 1; return route.fulfill({ status: 409, json: { error: "QA_NO_SEND" } }); });
  await page.goto("/messages?open=f927f7ee-9eca-4fbd-a837-5e87bc31ce02");
  await page.getByRole("button", { name: "Подбор", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Не удалось проверить канал отправки");
  const send = dialog.getByRole("button", { name: /^(Отправить|Ещё раз)$/ }).first();
  await expect(send).toBeDisabled();
  failed = false;
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(send).toBeEnabled();
  expect(sends).toBe(0);
});

test("Clean phone calls use the shared daily and monthly summary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/calls");
  const summary = page.locator("[data-clean-calls-summary]");
  await expect(summary).toBeVisible();
  await expect(summary.getByText("Сегодня · Душанбе", { exact: true })).toHaveCount(3);
  await expect(summary.getByText("Средний балл · 30 дней", { exact: true })).toBeVisible();
  await summary.getByRole("button", { name: /^Пропущенные/ }).click();
  await expect(page).toHaveURL(/[?&]slice=missed(?:&|$)/);
  await expect(page.getByRole("tab", { name: /^Пропущенные/ })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page).toHaveURL(/[?&]slice=missed(?:&|$)/);
  await expect(page.getByRole("tab", { name: /^Пропущенные/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(390);
});

for (const width of [1440, 390]) test(`Clean link hit targets do not cover adjacent tabs at ${width}px`, async ({ page }) => {
  await login(page);
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), botTrainingScreenEnabled: false } });
  });
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/ai-learning?tab=manner");
  const link = page.getByRole("link", { name: "Включить в настройках", exact: true });
  await expect(link).toBeVisible();
  await expect.poll(() => link.evaluate((node) => getComputedStyle(node).position)).toBe("relative");
  const tab = page.getByRole("tab", { name: "Куда уходят клиенты", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
});

for (const width of [1440, 390]) test(`Clean calendar retains date views and one header at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/calendar");
  const calendar = page.locator(".clean-calendar-page");
  await expect(calendar).toBeVisible();
  const tabs = calendar.getByRole("tablist", { name: /Вид календаря|Что показывать в календаре/ });
  for (const name of ["День", "Неделя", "Месяц"]) {
    await tabs.getByRole("tab", { name, exact: true }).click();
    await expect(tabs.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  if (width === 390) {
    await expect(calendar.locator(".mh > .top")).toBeHidden();
    await expect(page.locator('.clean-existing-topbar [data-topbar]')).toBeVisible();
    await expect(calendar.locator(".clean-calendar-summary")).toBeVisible();
  }
  // Existing complete/reschedule/cancel/call actions remain unclicked.
});

for (const width of [1440, 390]) test(`Clean profile keeps all sections in one responsive surface at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/profile");
  const profile = page.locator(".clean-profile-page");
  await expect(profile).toBeVisible();
  await expect(profile.locator(".mh")).toHaveCount(0);
  const tabs = profile.getByRole("tablist", { name: "Разделы профиля", exact: true });
  for (const name of ["Личные данные", "Вид и приложение", "Уведомления", "Безопасность", "Устройства", "Подключения"]) {
    const tab = tabs.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const target = await tab.getAttribute("aria-controls");
    expect(target).toBeTruthy();
    await expect(profile.locator(`#${target}`)).toBeVisible();
    await expect(profile.locator(`#${target}`)).not.toHaveText("");
    await expect(profile.getByRole("tabpanel")).toHaveCount(1);
  }
  await tabs.getByRole("tab", { name: "Подключения", exact: true }).press("Home");
  await expect(tabs.getByRole("tab", { name: "Личные данные", exact: true })).toBeFocused();
  // No account fields, password, notification permission or save action are changed.
});

for (const width of [1440, 390]) test(`Clean finance activates scoped styles for charts, pulse and payout blocks at ${width}px`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/finance?workspace=overview");
  const overview = page.getByRole("tabpanel", { name: "Обзор и прогноз", exact: true });
  const hit = overview.locator(".chart .hit").first();
  await expect(hit).toBeVisible();
  // An unstyled SVG hit rectangle defaults to opaque black and covers the plot.
  // Checking text/overflow alone cannot detect this regression.
  await expect.poll(() => hit.evaluate((node) => getComputedStyle(node).fill)).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
  await expect.poll(() => overview.locator(".seg").first().evaluate((node) => getComputedStyle(node).display)).toBe("flex");
  await expect.poll(() => overview.locator(".chart .gl").first().evaluate((node) => getComputedStyle(node).stroke)).not.toBe("none");
  await expect.poll(() => overview.locator(".chart .br").count()).toBeGreaterThan(0);
  if (width === 390) await expect.poll(() => overview.locator(".chart.compact").evaluateAll((charts) => charts.length === 2 && charts.every((chart) => {
    const svg = chart.querySelector("svg")!;
    return chart.scrollWidth <= chart.clientWidth + 1 && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) <= 2;
  }))).toBe(true);
  await expect.poll(() => overview.locator(".sec").first().evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
  await expect.poll(() => overview.locator(".trio .n b > .money").first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(20);
  await overview.locator(".trio button").nth(1).click();
  await expect(page.getByRole("tabpanel", { name: "Расходы", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Обзор и прогноз", exact: true }).click();
  await overview.locator(".trio button").nth(2).click();
  await expect(page.locator("#profit-chart-section")).toBeFocused();
  await page.getByRole("tab", { name: "Выплаты", exact: true }).click();
  const payouts = page.getByRole("tabpanel", { name: "Выплаты", exact: true });
  await expect(payouts.locator(".cef-overview > .scr")).toBeVisible();
});

test("Clean messenger retains drafts, opens latest history, and explains a failed conversation", async ({ page }, testInfo) => {
  await login(page);
  const now = new Date().toISOString();
  const rows = ["qa-chat-a", "qa-chat-b", "qa-chat-error"].map((id, index) => ({
    id, channel: "INSTAGRAM", name: ["Тест переписки А", "Тест переписки Б", "Тест ошибки"][index], clientShortId: null,
    lastMessage: { role: "user", content: "Ищу квартиру", by: undefined }, lastMessageAt: now, paused: false,
    awaitingHumanSince: null, pausedSince: null, unread: false, unreadCount: 0, messagesCount: 80,
    accountId: "qa-account", accountTitle: "Тестовый аккаунт", agentAttentionRequestedAt: null,
  }));
  let fail = true;
  let sends = 0;
  await page.route("**/api/v1/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") { sends++; return route.fulfill({ status: 400, json: { error: "Не отправлять тестовую переписку" } }); }
    if (url.pathname.endsWith("/conversations")) return route.fulfill({ json: {
      items: rows, total: rows.length, page: 1, pageSize: 50, channels: ["INSTAGRAM", "WHATSAPP"],
      accounts: [{ id: "qa-account", title: "Royal Home", channel: "INSTAGRAM" }, { id: "qa-account-two", title: "Royal Home Info", channel: "INSTAGRAM" }],
      counts: { all: 3, needsHuman: 0, paused: 0, mine: 0 }, alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } },
    } });
    const id = url.pathname.split("/").at(-1);
    const row = rows.find((item) => item.id === id);
    if (!row) return route.fallback();
    if (id === "qa-chat-error" && fail) return route.fulfill({ status: 404, json: { error: "Диалог недоступен" } });
    return route.fulfill({ json: { ...row, profileName: row.name, subscriberId: "qa-profile", clientId: null,
      clientPhone: null, firstContactAt: now, pausedUntil: null, shieldPause: null, contact: null,
      messages: Array.from({ length: 80 }, (_, index) => ({ mid: `${id}-${index}`, role: "user", content: `Сообщение ${index + 1}. Нужна квартира в центре, уточните условия просмотра.`, at: now })),
    } });
  });
  await page.goto("/messages");
  const first = page.getByRole("region", { name: "Диалог: Тест переписки А", exact: true });
  await expect(first).toBeVisible();
  const thread = first.getByLabel("Переписка", { exact: true });
  await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);
  const filters = page.locator(".clean-inbox-filters");
  await expect(filters).not.toHaveAttribute("open", "");
  await filters.locator("summary").click();
  await expect(page.getByLabel("Аккаунт компании")).toBeVisible();
  await filters.locator("summary").click();
  await first.getByLabel("Текст ответа").fill("Черновик для А");
  await page.getByRole("button").filter({ has: page.locator("b", { hasText: "Тест переписки Б" }) }).click();
  const second = page.getByRole("region", { name: "Диалог: Тест переписки Б", exact: true });
  await expect(second.getByLabel("Текст ответа")).toHaveValue("");
  await second.getByLabel("Текст ответа").fill("Черновик для Б");
  await page.getByRole("button").filter({ has: page.locator("b", { hasText: "Тест переписки А" }) }).click();
  await expect(first.getByLabel("Текст ответа")).toHaveValue("Черновик для А");
  await page.reload();
  await expect(first.getByLabel("Текст ответа")).toHaveValue("Черновик для А");
  await page.evaluate(() => { document.documentElement.dataset.theme = "royal-home-2026-light"; });
  await page.screenshot({ path: testInfo.outputPath("messages-presentation-qa-light.png"), animations: "disabled" });
  await thread.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await first.getByRole("button", { name: "К последним сообщениям" }).click();
  await expect.poll(() => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5);
  await page.getByRole("button").filter({ has: page.locator("b", { hasText: "Тест ошибки" }) }).click();
  await expect(page.getByRole("heading", { name: "Не удалось открыть диалог" })).toBeVisible();
  await expect(page.getByLabel("Текст ответа")).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Повторить загрузку диалога" }).click();
  await expect(page.getByRole("region", { name: "Диалог: Тест ошибки", exact: true }).getByLabel("Текст ответа")).toBeVisible();
  for (const width of [1440, 1280, 820]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "night"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = `royal-home-2026-${value}`; }, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  // Browser-history navigation to a second notification must change the open
  // thread even when Chats is already mounted (main #1150).
  await page.evaluate(() => {
    history.pushState({ key: "qa-notification-open" }, "", "/messages?open=qa-chat-b");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(second).toBeVisible();
  await expect(second.getByLabel("Текст ответа")).toHaveValue("Черновик для Б");
  // On a phone the OS/PWA Back is the same action as the visible inbox Back.
  // Selection belongs to the route, including reload and external deep links.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/messages?channel=keep-this-filter");
  const firstRow = page.getByRole("button").filter({ has: page.locator("b", { hasText: "Тест переписки А" }) });
  await firstRow.click();
  await expect(first).toBeVisible();
  await expect(page).toHaveURL(/channel=keep-this-filter&open=qa-chat-a/);
  await page.goBack();
  await expect(firstRow).toBeVisible();
  await expect(page).toHaveURL(/\/messages\?channel=keep-this-filter$/);
  await page.goForward();
  await expect(first).toBeVisible();
  await page.reload();
  await expect(first).toBeVisible();
  await first.getByRole("button", { name: "Назад к списку чатов", exact: true }).click();
  await expect(firstRow).toBeVisible();
  await expect(page).toHaveURL(/\/messages\?channel=keep-this-filter$/);
  // A notification may open without an inbox entry: Back must remain in Chats,
  // clear only the conversation and retain unrelated query parameters.
  await page.goto("/messages?channel=keep-this-filter&open=qa-chat-b");
  await expect(second).toBeVisible();
  await second.getByRole("button", { name: "Назад к списку чатов", exact: true }).click();
  await expect(firstRow).toBeVisible();
  await expect(page).toHaveURL(/\/messages\?channel=keep-this-filter$/);
  expect(sends).toBe(0);
});

test("Clean section links keep the shell mounted without document reload", async ({ page }) => {
  await login(page);
  await expect(page.locator(".clean-header")).toBeVisible();
  await page.locator(".clean-header").evaluate((node) => { node.setAttribute("data-qa-retained-header", "true"); });
  let documents = 0;
  page.on("request", (request) => { if (request.resourceType() === "document") documents++; });
  for (const [label, heading] of [["Клиенты", "Клиенты"], ["Чаты", "Чаты"], ["Объекты", "Объекты"], ["Сделки", "Сделки"], ["Деньги", "Деньги"]]) {
    const link = page.getByRole("navigation", { name: "Основные разделы", exact: true }).getByRole("link", { name: new RegExp(`^${label}(?:$| Новых:)`) });
    await link.hover();
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(page.locator(".clean-header")).toHaveAttribute("data-qa-retained-header", "true");
  }
  expect(documents).toBe(0);
});
const directorPhone = process.env.E2E_PHONE ?? "+992900000000";
let originalRollout: UiShellRollout | undefined;

async function login(page: Page, phone = directorPhone) {
  const base = new URL(process.env.E2E_BASE_URL ?? "http://invalid");
  await page.route("**/api/**", (route) => {
    const recipient = new URL(route.request().url());
    if (recipient.origin !== base.origin) return route.abort("blockedbyclient");
    return route.fallback();
  });
  await page.addInitScript(() => {
    localStorage.setItem("royal-home-device-id", "e2e-clean-shell");
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("rh:passkey-offer-dismissed", "1");
    localStorage.setItem("royal-home-push-nudge-dismissed-until", String(Date.now() + 86_400_000));
  });
  // Serial QA must not perform forty code logins against the real 20/15min
  // protection. Reuse only server-issued seed cookies, refresh through the real
  // endpoint, and retain the latest rotated cookie after each scenario.
  const session = seedSessions.get(phone);
  if (session?.cookies.length) {
    await page.context().addCookies(session.cookies);
    // Preserve the exact real UI persistence marker as well as its HttpOnly
    // cookie. It contains no JWT; the app still obtains its token from refresh.
    await page.addInitScript((value) => localStorage.setItem("royal-home-auth", value), session.authStorage);
    const refreshed = page.waitForResponse((res) => res.url().endsWith("/auth/refresh") && res.request().method() === "POST");
    await page.goto("/");
    const response = await refreshed;
    expect(response.ok(), `Seed session refresh HTTP ${response.status()}`).toBe(true);
    accessTokens.set(page, (await response.json()).accessToken);
    contextPhones.set(page.context(), phone);
    await retainSeedSession(page, phone);
    await expect(page).not.toHaveURL(/\/login/);
    return;
  }
  await page.goto("/login");
  await page.getByLabel("Рабочий телефон").fill(phone);
  await page.getByRole("button", { name: "Получить код", exact: true }).click();
  const codeField = page.getByRole("textbox", { name: /Код из/ });
  await expect(codeField).toHaveValue(/^\d{6}$/, { timeout: 10_000 });
  const response = page.waitForResponse((res) => res.url().endsWith("/auth/login/verify-code") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  const authenticated = await response;
  expect(authenticated.ok(), `Seed login HTTP ${authenticated.status()}`).toBe(true);
  accessTokens.set(page, (await authenticated.json()).accessToken);
  contextPhones.set(page.context(), phone);
  await retainSeedSession(page, phone);
  await expect(page).not.toHaveURL(/\/login/);
}

async function elevatedHeaders(page: Page) {
  const headers = { Authorization: `Bearer ${accessTokens.get(page)}` };
  // Elevation belongs to the actor and outlives this browser session. Reuse a
  // fresh server grant instead of consuming the production 8 POST / 5 min limit.
  const status = await page.request.get("/api/v1/auth/step-up", { headers });
  expect(status.ok(), `Seed elevation status HTTP ${status.status()}`).toBe(true);
  const current = await status.json() as { elevated: boolean; expiresAt: string | null };
  // An active grant can expire between this read and the guarded write. Renew
  // only when it cannot cover setup; keep the server's TTL and rate limit intact.
  const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
  if (!current.elevated || !Number.isFinite(expiresAt) || expiresAt - Date.now() < 60_000) {
    await stepUpByCode(page.request, headers);
  }
  return headers;
}

async function writeRollout(page: Page, headers: Record<string, string>, value: UiShellRollout) {
  const current = await page.request.get("/api/v1/ui-shell/config", { headers });
  expect(current.ok()).toBe(true);
  const snapshot = await current.json() as UiShellRolloutConfig;
  return page.request.put("/api/v1/ui-shell/config", {
    maxRedirects: 0,
    headers: { ...headers, "If-Match": `"${snapshot.version}"` },
    data: { enabled: value.enabled, agentIds: value.agentIds, roles: value.roles },
  });
}

async function liveFixture(page: Page, update: (data: McLive) => void) {
  const response = await page.request.get("/api/v1/dashboard/mission-control/live", { headers: { Authorization: `Bearer ${accessTokens.get(page)}` } });
  expect(response.ok()).toBe(true);
  const data = await response.json() as McLive;
  update(data);
  await page.route("**/api/v1/dashboard/mission-control/live", (route) => route.fulfill({ json: data }));
}

// Refresh cookies rotate on use. Serial scenarios retain their latest issued
// cookie; a static saved cookie must never be replayed across contexts.
// These scenarios intercept API fixtures. A production service worker can own
// requests after reload and bypass page.route; offline/PWA behavior has its own suite.
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
// The switch scenario changes a stand-wide setting. Keep this file serial and
// run only its desktop project; the role matrix below includes phone viewports.
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(60_000);
  const target = new URL(baseURL ?? "http://invalid");
  test.skip(target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname) || !target.port || target.port === "5284" || process.env.E2E_ISOLATED_SEED !== "1" || process.env.E2E_ALLOW_ROLLOUT_WRITES !== "1", "explicit isolated seed stand and rollout-write authorization required");
  test.skip(Boolean(testInfo.project.use.isMobile), "phone paths are covered by this suite's role matrix");
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await login(page);
    const headers = await elevatedHeaders(page);
    const response = await page.request.get("/api/v1/ui-shell/config", { headers });
    expect(response.ok()).toBe(true);
    originalRollout = await response.json() as UiShellRollout;
    const configured = await writeRollout(page, headers,
      { enabled: true, agentIds: originalRollout.agentIds, roles: [...new Set<UiShellRollout["roles"][number]>([...originalRollout.roles, "DIRECTOR", "ADMIN", "AGENT", "MANAGER", "SHAREHOLDER"])] });
    expect(configured.ok()).toBe(true);
  } finally { await context.close(); }
});
test.afterAll(async ({ browser, baseURL }) => {
  if (!originalRollout) return;
  test.setTimeout(60_000);
  // A fresh session avoids restoring with an expired test token/elevation.
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await login(page);
    const headers = await elevatedHeaders(page);
    const restored = await writeRollout(page, headers, originalRollout);
    expect(restored.ok()).toBe(true);
  } finally { await context.close(); }
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  const phone = contextPhones.get(page.context());
  if (phone) await retainSeedSession(page, phone);
});
test.beforeEach(async ({ page }, testInfo) => {
  // These two scenarios deliberately own their login. Logging in twice makes
  // the authenticated /login route redirect and leaves the second form wait stuck.
  if (testInfo.title.startsWith("Clean ")) return;
  if (testInfo.title.startsWith("clean: reports draft") || testInfo.title.startsWith("clean: work queues") || testInfo.title.startsWith("clean: detail navigation") || testInfo.title.startsWith("clean: personal navigation")) return;
  if (/clean: (director|admin|agent|manager) desktop/.test(testInfo.title)) return;
  await login(page);
});

test("clean: server switch survives navigation and cannot be bypassed by URL", async ({ page }, testInfo) => {
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(testInfo.project.use.baseURL ?? ""), "local seeded stand only");
  const headers = { Authorization: `Bearer ${accessTokens.get(page)}` };
  const original = await page.request.get("/api/v1/ui-shell/config", { headers });
  expect(original.ok()).toBe(true);
  expect(original.headers()["cache-control"]).toContain("no-store");
  const config = await original.json();
  const publicSettings = await page.request.get("/api/v1/settings", { headers });
  expect(publicSettings.ok()).toBe(true);
  expect(await publicSettings.json()).not.toHaveProperty("uiShellRollout");
  await stepUpByCode(page.request, headers);
  try {
    await page.goto("/settings?tab=system&task=workspace&shell=clean");
    const section = page.locator(".shell-rollout");
    await expect(section).toBeVisible();
    const toggle = section.getByRole("checkbox", { name: "Включить новый интерфейс для выбранных ниже" });
    await toggle.uncheck();
    const update = page.waitForResponse((res) => res.url().endsWith("/ui-shell/config") && res.request().method() === "PUT");
    await section.getByRole("button", { name: "Сохранить доступ" }).click();
    expect((await update).ok()).toBe(true);
    await expect(page.locator(".clean-header")).toHaveCount(0);
    await page.goto("/?shell=clean");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
    const effective = await page.request.get("/api/v1/ui-shell", { headers });
    expect(await effective.json()).toEqual({ enabled: false });
    await page.goto("/settings?tab=agency");
    await expect(section).toBeVisible();
    await toggle.check();
    const enable = page.waitForResponse((res) => res.url().endsWith("/ui-shell/config") && res.request().method() === "PUT");
    await section.getByRole("button", { name: "Сохранить доступ" }).click();
    expect((await enable).ok()).toBe(true);
    await expect(page.locator(".clean-header")).toBeVisible();
  } finally {
    const restored = await writeRollout(page, headers, config);
    expect(restored.ok()).toBe(true);
  }
});

test("clean: concurrent settings change keeps the draft and requires review", async ({ page }) => {
  const headers = await elevatedHeaders(page);
  const response = await page.request.get("/api/v1/ui-shell/config", { headers });
  const initial = await response.json() as UiShellRolloutConfig;
  try {
    await page.goto("/settings?tab=system&task=workspace&shell=clean");
    const section = page.locator(".shell-rollout");
    const agent = section.getByRole("checkbox", { name: "Агент", exact: true });
    const editor = section.getByRole("checkbox", { name: ROLE_LABELS.EDITOR, exact: true });
    await expect(agent).toBeChecked({ checked: initial.roles.includes("AGENT") });
    await agent.setChecked(!initial.roles.includes("AGENT"));
    const roles = initial.roles.includes("EDITOR") ? initial.roles.filter((role) => role !== "EDITOR") : [...initial.roles, "EDITOR" as const];
    expect((await writeRollout(page, headers, { ...initial, roles })).ok()).toBe(true);
    const write = page.waitForResponse((res) => res.url().endsWith("/ui-shell/config") && res.request().method() === "PUT");
    await section.getByRole("button", { name: "Сохранить доступ" }).click();
    expect((await write).status()).toBe(409);
    await expect(section.getByRole("alert")).toContainText("другим администратором");
    await expect(section.getByText(/Ваши правки перенесены/)).toBeVisible();
    await expect(agent).toBeChecked({ checked: !initial.roles.includes("AGENT") });
    await expect(editor).toBeChecked({ checked: !initial.roles.includes("EDITOR") });
    const current = await page.request.get("/api/v1/ui-shell/config", { headers });
    expect((await current.json()).roles.includes("AGENT")).toBe(initial.roles.includes("AGENT"));
  } finally { expect((await writeRollout(page, headers, initial)).ok()).toBe(true); }
});

test("clean: critical notices respect dialogs and persist personal decisions", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only");
  await liveFixture(page, (data) => {
    data.firstLine = { items: [1, 2].map((n) => ({ id: `notice-${n}`, severity: "critical", text: `Проверка внимания ${n}`, href: "/clients" })), shownCount: 2, totalCount: 2 };
  });
  await page.goto("/?shell=clean");
  const notice = page.getByRole("complementary", { name: "Критическое событие" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Проверка внимания 1");
  await expect(notice.getByRole("link", { name: "Разобрать" })).toHaveAttribute("href", "/clients");
  expect(await notice.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  await page.goto("/clients?shell=clean");
  await expect(notice).toContainText("Проверка внимания 1");
  await page.goto("/?shell=clean");
  await expect(page.locator(".clean-header")).toBeVisible();
  await page.locator("[data-topbar-search-wide]").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(notice).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Напомнить через час" }).click();
  await expect(notice).toContainText("Проверка внимания 2");
  await page.reload();
  await expect(notice).toContainText("Проверка внимания 2");
  await notice.getByRole("button", { name: "Понял", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".clean-header")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Нужны ваши решения" })).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("clean: ask AI submits data, suppresses notices and restores focus", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only");
  const question = "Что требует внимания руководителя сегодня?";
  const answer = "Проверочный ответ: сначала проверьте задачи команды.";
  const submitted: unknown[] = [];
  // Keep both AI entry points offline: this test verifies UI/request contracts,
  // never the external model or morning-briefing generation.
  await page.route("**/api/v1/dashboard/briefing", (route) => route.fulfill({ status: 503, json: { error: "TEST_BRIEFING_UNAVAILABLE" } }));
  await page.route("**/api/v1/dashboard/mission-control/ask", async (route) => {
    expect(route.request().method()).toBe("POST");
    submitted.push(route.request().postDataJSON());
    // dashboardMissionControl's ask endpoint returns this exact DTO.
    await route.fulfill({ json: { answer } });
  });
  await liveFixture(page, (data) => {
    data.firstLine = { items: [{ id: "ask-sheet-critical", severity: "critical", text: "Проверка внимания при вопросе ИИ", href: "/clients" }], shownCount: 1, totalCount: 1 };
  });
  await page.goto("/?shell=clean");
  const notice = page.getByRole("complementary", { name: "Критическое событие" });
  await expect(notice).toBeVisible();
  const trigger = page.getByRole("button", { name: "Спросить ИИ", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Спросить ИИ", exact: true });
  await expect(sheet).toBeVisible();
  await expect(notice).toHaveCount(0);
  const input = sheet.getByLabel("Вопрос к данным компании");
  await expect(sheet.getByRole("button", { name: "Спросить", exact: true })).toBeDisabled();
  await input.fill(`  ${question}  `);
  await sheet.getByRole("button", { name: "Спросить", exact: true }).click();
  await expect(sheet.getByText(answer, { exact: true })).toBeVisible();
  expect(submitted).toEqual([{ question }]);
  await expect(notice).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(notice).toBeVisible();
});

test("clean: partial approval failure stays visible and team events are not clipped", async ({ page }) => {
  test.setTimeout(60_000);
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only");
  await page.route("**/api/v1/deals?stage=PENDING_APPROVAL", (route) => route.fulfill({ status: 503, json: { error: "TEST_UNAVAILABLE" } }));
  await liveFixture(page, (data) => {
    data.firstLine = { items: Array.from({ length: 7 }, (_, n) => ({ id: `team-event-${n}`, severity: "warn", text: `Событие команды ${n + 1}`, href: "/team" })), shownCount: 7, totalCount: 9 };
  });
  await page.goto("/?shell=clean");
  await expect(page.getByRole("alert").filter({ hasText: "Часть очереди решений недоступна" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Событие команды 7", { exact: true })).toBeVisible();
  await expect(page.getByText("Показаны 7 из 9 событий", { exact: false })).toBeVisible();
  await expect(page.getByText("В загруженных данных срочных нарушений нет.", { exact: false })).toHaveCount(0);
});

test("clean: rollout draft survives step-up expiry", async ({ page }) => {
  const headers = { Authorization: `Bearer ${accessTokens.get(page)}` };
  await stepUpByCode(page.request, headers);
  await page.goto("/settings?tab=system&task=workspace&shell=clean");
  const initialUrl = page.url();
  const section = page.locator(".shell-rollout");
  const agentRole = section.getByRole("checkbox", { name: "Агент", exact: true });
  await expect(agentRole).toBeVisible();
  const wasChecked = await agentRole.isChecked();
  await agentRole.setChecked(!wasChecked);
  await page.evaluate(() => window.dispatchEvent(new Event("step-up-required")));
  await expect(page.getByRole("heading", { name: "Подтвердите, что это вы" })).toBeVisible();
  await expect(page).toHaveURL(initialUrl);
  await expect(page.getByRole("textbox", { name: /Код из/ })).toHaveValue(/^\d{6}$/,{ timeout: 10_000 });
  const confirmation = page.waitForResponse((response) => response.url().endsWith("/auth/step-up") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  const confirmed = await confirmation;
  expect(confirmed.ok(), `Draft reauthentication HTTP ${confirmed.status()}`).toBe(true);
  await expect(page).toHaveURL(initialUrl);
  await expect(agentRole).toBeVisible();
  await expect(agentRole).toBeChecked({ checked: !wasChecked });
  await section.getByRole("button", { name: "Отменить изменения" }).click();
  await expect(agentRole).toBeChecked({ checked: wasChecked });
});

test("clean: cold policy load does not mount temporary legacy controls", async ({ page }) => {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestArrived = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/v1/ui-shell", async (route) => {
    arrived();
    await gate;
    await route.fulfill({ json: { enabled: true } });
  });
  try {
    await page.goto("/?shell=clean", { waitUntil: "domcontentloaded" });
    await requestArrived;
    await expect(page.getByLabel("Загрузка раздела")).toBeVisible();
    await expect(page.locator("[data-topbar-search-wide]")).toHaveCount(0);
    await expect(page.locator(".clean-header")).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator(".clean-header")).toBeVisible();
});

test("clean: polling error retains layout, explicit off and pult alias respect rollout", async ({ page }) => {
  await page.clock.install();
  await page.goto("/?shell=clean");
  await expect(page.locator(".clean-header")).toBeVisible();
  await page.route("**/api/v1/ui-shell", (route) => route.fulfill({ status: 500, json: { error: "TEST_UNAVAILABLE" } }));
  const failed = page.waitForResponse((response) => response.url().endsWith("/ui-shell") && response.status() === 500);
  await page.clock.fastForward(31_000);
  await failed;
  await page.clock.fastForward(5_000);
  await expect(page.locator(".clean-header")).toBeVisible();
  await page.unroute("**/api/v1/ui-shell");
  await page.route("**/api/v1/ui-shell", (route) => route.fulfill({ json: { enabled: false } }));
  const disabled = page.waitForResponse((response) => response.url().endsWith("/ui-shell") && response.ok());
  await page.clock.fastForward(31_000);
  await disabled;
  await expect(page.locator(".clean-header")).toHaveCount(0);
  await page.goto("/pult?shell=clean");
  await expect(page).toHaveURL(/\/pult\?shell=clean$/);
  await expect(page.locator(".clean-header")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
});

test("clean: existing sections and responsive breakpoints remain usable", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only; mobile legacy is checked separately");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of [...SECTIONS.map((section) => section.path), "/settings"]) {
    await page.goto(`${path}?shell=clean`);
    const heading = SECTIONS.find((item) => item.path === path)?.heading ?? (path === "/profile" ? /Профиль|Мой профиль/ : /Настройки/);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.goto("/?shell=clean");
  await expect(page.getByRole("heading", { name: "Нужны ваши решения" })).toBeVisible();
  for (const width of [360, 768, 820, 1024, 1180, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("clean: flag, navigation, search, creation and legacy escape hatch", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only; mobile legacy is checked separately");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?shell=clean");
  await expect(page.locator(".clean-header")).toBeVisible();
  await expect(page.locator(".sh-rail")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Нужны ваши решения" })).toBeVisible();
  const mobile = (page.viewportSize()?.width ?? 1440) < 820;
  await page.locator(mobile ? "[data-topbar-search]" : "[data-topbar-search-wide]").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel(/— все разделы(?:\. Новых: \d+)?$/).click();
  await expect(page.getByRole("navigation", { name: "Остальные разделы" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".clean-more")).not.toHaveAttribute("open");
  if (mobile) await page.goto("/properties/new");
  else await page.locator(".clean-create").click();
  // The existing creation wizard intentionally occupies its own full screen.
  await expect(page.getByRole("button", { name: "Закрыть мастер" })).toBeVisible();
  await expect(page.locator("input").first()).toBeVisible();
  await page.goto("/?shell=legacy");
  await expect(page.locator(".clean-header")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
  expect(errors).toEqual([]);
});

test("clean: client transfer sends the existing request and undo restores its agent", async ({ page }, testInfo) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 820, "Desktop rollout only");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(testInfo.project.use.baseURL ?? ""), "local seeded stand only");
  // A deterministic overdue queue: seed ages change with the calendar. These
  // read fixtures exercise the real UI/hooks without altering real assignments.
  await liveFixture(page, (data) => {
    if (!("dealsInPipeline" in data.hero)) throw new Error("Director mission-control hero fixture is unavailable");
    data.hero.dealsInPipeline.items = [1, 2].map((n) => ({ id: `e2e-client-${n}`, title: `Проверка передачи ${n}`, href: `/clients/${900000 + n}`, tone: "warn", hint: "Тестовая очередь без движения" }));
  });
  await page.route(/\/api\/v1\/clients\/90000[12]$/, (route) => route.fulfill({ json: { assignedAgent: { id: "e2e-previous-agent" } } }));
  await page.goto("/?shell=clean");
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  if (originalTheme !== "royal-home-2026-night") {
    const saved = page.waitForResponse(res => res.url().endsWith("/me/preferences") && res.request().method() === "PUT");
    await page.locator("[data-topbar-theme]:visible").first().click(); expect((await saved).ok()).toBe(true);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "royal-home-2026-night");
  try {
  await page.getByRole("button", { name: "Разобрать", exact: true }).first().click();
  const assignments: { agentId: string }[] = [];
  // Exercise the actual hook and undo callback; intercept only the write so the seed remains unchanged.
  await page.route("**/api/v1/clients/*/assign", async (route) => {
    assignments.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.getByRole("button", { name: "Передать", exact: true }).first().click();
  await expect.poll(() => assignments.length).toBe(1);
  const notice = page.locator(".toast").filter({ has: page.getByRole("button", { name: "Отменить", exact: true }) });
  const contrast = await notice.evaluate(node => {
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).reduce((sum, channel, index) => {
      const value = channel / 255;
      return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
    }, 0);
    const background = luminance(getComputedStyle(node).backgroundColor);
    return Math.min(...[node.querySelector("span")!, node.querySelector("button")!].map(text => {
      const foreground = luminance(getComputedStyle(text).color);
      return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05);
    }));
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect.poll(() => assignments.length).toBe(2);
  expect(assignments[0].agentId).toBeTruthy();
  expect(assignments[1].agentId).toBeTruthy();
  expect(assignments[1].agentId).not.toBe(assignments[0].agentId);
  } finally {
    if (await page.locator("html").getAttribute("data-theme") !== originalTheme) {
      const saved = page.waitForResponse(res => res.url().endsWith("/me/preferences") && res.request().method() === "PUT");
      await page.locator("[data-topbar-theme]:visible").first().click(); expect((await saved).ok()).toBe(true);
    }
  }
});

test("clean: work queues reveal real snapshot details and preserve section navigation", async ({ page }) => {
  await login(page, "+992900000001");
  const response = await page.request.get("/api/v1/dashboard/mission-control/zones", { headers: { Authorization: `Bearer ${accessTokens.get(page)}` } });
  expect(response.ok()).toBe(true);
  const zones = await response.json();
  zones.modulesOff = zones.modulesOff.filter((id: string) => id !== "bot" && id !== "calls");
  zones.bot = { ai: { requestsToday: 0, errorsToday: 0, errorRatePercent: 0, costUsdToday: null, avgMs: 0 }, guardHitsToday: 0, outboundShieldToday: 0, unresolvedFindings: null,
    attention: { liveCount: 7, silent: { count: 0, items: [], reason: null }, waitingHuman: { count: 7, reason: null, items: [{ id: "queue-dialog", kind: "TELEGRAM", channel: "TELEGRAM", title: "Диалог ждёт человека", clientId: null, lastMessageAt: "2026-10-09T04:00:00Z", waitingMinutes: 15 }] } } };
  await page.route("**/api/v1/dashboard/mission-control/zones", (route) => route.fulfill({ json: zones }));
  await liveFixture(page, (data) => {
    data.modulesOff = data.modulesOff.filter((id) => id !== "bot" && id !== "calls");
    data.calls = { live: { incoming: [{ channelId: "queue-call", clientName: null, clientShortId: null, answered: false, seconds: 12 }], outgoing: [] }, today: { incoming: 1, outgoing: 0, missed: 0, unqualified: 0 } };
  });
  await page.goto("/?shell=clean");
  const queues = page.getByRole("region", { name: "Рабочие очереди", exact: true });
  const dialogs = queues.locator(".clean-card").filter({ has: page.getByRole("heading", { name: "Ждут человека", exact: true }) });
  const dialogDetails = dialogs.locator("details");
  await expect(dialogDetails).not.toHaveAttribute("open", "");
  await expect(dialogs.getByRole("link", { name: /Диалог ждёт человека/ })).toHaveAttribute("href", "/messages?open=tg_queue-dialog");
  await dialogDetails.locator("summary").click();
  await expect(dialogDetails.getByText("TELEGRAM · ждёт 15 мин", { exact: false })).toBeVisible();
  await expect(dialogs.getByText("Доступных строк показано 1 из 7", { exact: false })).toBeVisible();
  const calls = queues.locator(".clean-card").filter({ has: page.getByRole("heading", { name: "Звонки", exact: true }) });
  await calls.locator("details summary").click();
  await expect(calls.getByText(/Сегодня: входящих 1, исходящих 0/)).toBeVisible();
  await calls.getByRole("link", { name: /Входящий звонок/ }).click();
  await expect(page).toHaveURL(/\/calls$/);
});

test("clean: detail navigation opens the selected team member by clicking their name", async ({ page }) => {
  await login(page, "+992900000001");
  await page.goto("/?shell=clean");
  const card = page.locator(".clean-card").filter({ has: page.getByRole("heading", { name: "Команда", exact: true }) });
  const member = card.locator('a[href^="/team/"]').first();
  await expect(member).toBeVisible();
  const destination = await member.getAttribute("href");
  const label = await member.getAttribute("aria-label");
  expect(destination).toMatch(/^\/team\/[^/]+$/);
  expect(label).toMatch(/^Открыть /);
  const name = label!.replace(/^Открыть /, "");
  await member.getByText(name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
});

test("clean: detail navigation keeps call log below compact and wide sticky headers", async ({ page }) => {
  await login(page, "+992900000001");
  for (const width of [820, 1440]) {
    await page.setViewportSize({ width, height: 500 });
    await page.goto("/calls?shell=clean");
    await expect(page.locator(".clean-header")).toBeVisible();
    await page.getByRole("button", { name: /^Пропущенные/ }).click();
    await expect(page.getByRole("tab", { name: "Пропущенные", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => page.evaluate(() => {
      const header = document.querySelector(".clean-header")!.getBoundingClientRect();
      const log = document.querySelector("#call-log")!.getBoundingClientRect();
      const gap = log.top - header.bottom;
      return gap >= 0 && gap <= 32;
    })).toBe(true);
    await page.locator(".clean-header").getByRole("link", { name: "Клиенты", exact: true }).click();
    await expect(page).toHaveURL(/\/clients$/);
    await expect.poll(() => page.locator(".clean-frame").evaluate((frame) => frame.scrollTop)).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/calls\?/);
    await expect.poll(() => page.evaluate(() => {
      const header = document.querySelector(".clean-header")!.getBoundingClientRect();
      const log = document.querySelector("#call-log")!.getBoundingClientRect();
      const gap = log.top - header.bottom;
      return gap >= 0 && gap <= 32;
    })).toBe(true);
    // Native keyboard focus in a sticky header must preserve the scroll position
    // before navigation, not record a focus-induced jump as the Calls position.
    const remembered = await page.locator(".clean-frame").evaluate((frame) => frame.scrollTop);
    await page.locator(".clean-header").getByRole("link", { name: "Чаты", exact: true }).evaluate((link) => (link as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(".clean-header").getByRole("link", { name: "Клиенты", exact: true })).toBeFocused();
    expect(await page.locator(".clean-frame").evaluate((frame) => frame.scrollTop)).toBe(remembered);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/clients$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/calls\?/);
    await expect.poll(() => page.evaluate(() => {
      const header = document.querySelector(".clean-header")!.getBoundingClientRect();
      const log = document.querySelector("#call-log")!.getBoundingClientRect();
      const gap = log.top - header.bottom;
      return gap >= 0 && gap <= 32;
    })).toBe(true);
  }
});

test("clean: property showing picker identifies clients and keeps the existing scheduling form", async ({ page }) => {
  const headers = { Authorization: `Bearer ${accessTokens.get(page)}` };
  const response = await page.request.get("/api/v1/clients?pageSize=12", { headers });
  expect(response.ok()).toBe(true);
  const data = await response.json() as { items: { id: string; fullName: string; phone: string; shortId: number }[]; total: number };
  expect(data.items.length).toBeGreaterThan(0);
  await page.route("**/api/v1/clients?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: data });
  });
  await page.goto("/properties/19");
  const schedule = page.getByRole("button", { name: "Назначить показ", exact: true });
  await expect(schedule).toBeVisible();
  await expect(schedule).toHaveCSS("box-shadow", "none");
  const night = await page.locator("html").getAttribute("data-theme") === "royal-home-2026-night";
  await expect(schedule).toHaveCSS("background-color", night ? "rgb(36, 87, 214)" : "rgb(37, 94, 245)");
  await expect(schedule).toHaveCSS("padding-left", "22px");
  await expect.poll(() => page.evaluate(() => {
    const gallery = document.querySelector('[data-testid="gallery"]')!;
    const track = gallery.querySelector('.rh-gallery-track')!;
    return Math.abs(gallery.getBoundingClientRect().width - track.getBoundingClientRect().width);
  })).toBeLessThanOrEqual(1);
  await schedule.click();
  const picker = page.getByRole("dialog", { name: "Назначить показ · выберите клиента" });
  await expect(picker).toBeVisible();
  const firstClient = data.items[0];
  const row = picker.getByRole("button").filter({ hasText: firstClient.fullName }).first();
  await expect(row).toContainText(firstClient.phone);
  await expect(row).toContainText(String(firstClient.shortId).padStart(6, "0"));
  await row.click();
  const form = page.getByRole("dialog", { name: "Назначить показ", exact: true });
  await expect(form.getByLabel("Дата показа *", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Время *", { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(form).toHaveCount(0);
});

test("clean: personal navigation persists on the server and resets without changing permissions", async ({ page, browser, baseURL }) => {
  test.setTimeout(60_000);
  await login(page, "+992900000001");
  const headers = { Authorization: `Bearer ${accessTokens.get(page)}` };
  const profile = await page.request.get("/api/v1/me", { headers });
  expect(profile.ok()).toBe(true);
  const original = (await profile.json()).preferences ?? {};
  const tabs = page.locator(".clean-tabs a");
  const openEditor = async () => {
    await page.getByLabel(/— все разделы(?:\. Новых: \d+)?$/).click();
    await page.getByRole("button", { name: "Настроить порядок вкладок", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Порядок вкладок" })).toBeVisible();
  };
  try {
    await page.goto("/?shell=clean");
    await openEditor();
    const dialog = page.getByRole("dialog", { name: "Порядок вкладок" });
    await dialog.getByRole("button", { name: "Клиенты: выше", exact: true }).click();
    const saved = page.waitForResponse((response) => response.url().endsWith("/me/preferences") && response.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(tabs.first()).toHaveAttribute("href", "/clients");
    await page.reload();
    await expect(tabs.first()).toHaveAttribute("href", "/clients");
    const freshContext = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
    try {
      const fresh = await freshContext.newPage();
      await login(fresh, "+992900000001");
      await expect(fresh.locator(".clean-tabs a").first()).toHaveAttribute("href", "/clients");
    } finally { await freshContext.close(); }
    await openEditor();
    await dialog.getByRole("button", { name: "Вернуть исходный порядок", exact: true }).click();
    const reset = page.waitForResponse((response) => response.url().endsWith("/me/preferences") && response.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await reset).ok()).toBe(true);
    await expect(tabs.first()).toHaveText("Сегодня");
    await expect(tabs).toHaveCount(6);
  } finally {
    const restored = await page.request.put("/api/v1/me/preferences", { headers, data: original });
    expect(restored.ok()).toBe(true);
  }
});

for (const kind of ["monthly", "problems"] as const) {
  test(`clean: reports draft ${kind} survives background refresh and requires conflict choice`, async ({ page }) => {
    await login(page, "+992900000001");
    const notes = { value: "Сохранённый текст" };
    const savedBodies: unknown[] = [];
    const report = () => ({
      id: `draft-${kind}`, period: "week", periodStart: "2026-08-31T19:00:00Z", periodEnd: "2026-09-07T19:00:00Z",
      notes: notes.value, updatedBy: null, updatedAt: "2026-09-08T00:00:00Z",
      metrics: kind === "monthly"
        ? { funnel: [], commission: 0, dealsCompleted: 0, expenses: 0, agents: [], sources: [], propertiesAdded: 0, propertiesSold: 0 }
        : { headline: "Проверка черновика", sections: [] },
    });
    await page.route(`**/api/v1/reports/${kind}**`, async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as { notes: string };
        savedBodies.push(body);
        notes.value = body.notes;
        return route.fulfill({ json: report() });
      }
      if (request.method() === "POST") {
        notes.value = "Изменено другим сотрудником";
        return route.fulfill({ json: { created: false } });
      }
      return route.fulfill({ json: [report()] });
    });
    await page.goto("/reports?shell=clean");
    const title = kind === "monthly" ? "Месячные отчёты" : "Разбор проблемных мест";
    const section = page.locator(".sec").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    await section.getByRole("button", { name: "Изменить", exact: true }).click();
    const editor = section.getByRole("textbox", { name: kind === "monthly" ? "Дополнения к месячному отчёту" : "Дополнения к разбору проблемных мест" });
    await editor.fill("Мой несохранённый текст");
    await section.getByRole("button", { name: "Собрать сейчас", exact: true }).click();
    await expect(section.getByRole("alert").filter({ hasText: "Дополнения изменились на сервере" })).toBeVisible();
    await expect(editor).toHaveValue("Мой несохранённый текст");
    await expect(section.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
    expect(savedBodies).toEqual([]);
    await section.getByRole("button", { name: "Оставить мой вариант", exact: true }).click();
    await section.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(savedBodies).toHaveLength(1);
    expect(savedBodies[0]).toMatchObject({ notes: "Мой несохранённый текст" });
    await expect(section.getByText("Мой несохранённый текст", { exact: true })).toBeVisible();
  });
}

for (const role of ["director", "admin", "agent", "manager"] as const) {
  test(`clean: ${role} desktop and phone, day and night`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // Only local seed identities. Never run this matrix against a production deployment.
    test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(testInfo.project.use.baseURL ?? ""), "local seeded stand only");
    const suffix = { director: "0", admin: "1", agent: "2", manager: "4" }[role];
    await login(page, `+99290000000${suffix}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [1440, 820, 390]) {
      for (const theme of ["light", "night"]) {
        // Use the real control and await server persistence. Editing localStorage
        // alone races authenticated preference hydration on the next navigation.
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto("/?shell=clean");
        await expect(page.locator(".clean-header")).toBeVisible();
        if (await page.locator("html").getAttribute("data-theme") !== `royal-home-2026-${theme}`) {
          const persisted = page.waitForResponse((response) => response.url().endsWith("/me/preferences") && response.request().method() === "PUT");
          await page.locator("[data-topbar-theme]:visible").first().click();
          expect((await persisted).ok()).toBe(true);
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", `royal-home-2026-${theme}`);
        await page.setViewportSize({ width, height: width >= 820 ? 1000 : 844 });
        await page.goto("/?shell=clean");
        if (role === "agent" && width < 820) {
          await expect(page.locator(".clean-header")).toHaveCount(0);
          await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
        } else {
          await expect(page.locator(".clean-header")).toBeVisible();
          // The document can have no overflow while a clipped nav silently hides a route.
          await expect.poll(() => page.locator(".clean-tabs").evaluate((nav) => {
            const bounds = nav.getBoundingClientRect();
            return [...nav.querySelectorAll("a")].every((link) => {
              const rect = link.getBoundingClientRect();
              return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && link.scrollWidth <= link.clientWidth + 1;
            });
          })).toBe(true);
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", `royal-home-2026-${theme}`);
        if (width >= 820 && (role === "director" || role === "admin")) {
          await expect(page.getByRole("heading", { name: "Нужны ваши решения" })).toBeVisible();
          await expect(page.locator(".clean")).toHaveAttribute("aria-busy", "false");
        }
        else if (role === "agent" && width < 820) {
          await expect(page.locator(".rh2 .mh .greet")).toHaveText(/^Салом/);
          await expect(page.locator("nav[data-bottomnav]").getByRole("link", { name: "Ещё", exact: true })).toBeVisible();
          await expect(page.locator("nav[data-bottomnav]").getByRole("link", { name: /^Чаты/ })).toBeVisible();
          await expect(page.locator(".rh-home")).toHaveCount(0);
        }
        else if (role === "agent") await expect(page.locator(".rh-home .rh-focus")).toBeVisible();
        else await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // Browser lazy loading is not required to fetch photographs in closed
        // details. Reveal their real UI and scroll them into view before checking
        // every image; neither remove the assertions nor force eager loading.
        const closedQueueSummaries = await page.getByRole("region", { name: "Рабочие очереди", exact: true })
          .locator("details:not([open]) > summary").elementHandles();
        for (const summary of closedQueueSummaries) await summary.click();
        for (const image of await page.locator('img[loading="lazy"]').all()) {
          if (await image.isVisible()) await image.scrollIntoViewIfNeeded();
        }
        await expect.poll(() => page.evaluate(() => [...document.images]
          .filter((image) => !image.complete || image.naturalWidth === 0)
          .map((image) => ({
            path: new URL(image.currentSrc || image.src, location.href).pathname,
            loading: image.loading,
            complete: image.complete,
            visible: image.checkVisibility(),
            closedDetails: Boolean(image.closest("details:not([open])")),
          })))).toEqual([]);
        for (const summary of closedQueueSummaries) await summary.click();
        await page.evaluate(() => {
          document.querySelector(".clean-frame")?.scrollTo(0, 0);
          window.scrollTo(0, 0);
        });
        await page.screenshot({ path: testInfo.outputPath(`${role}-${width}-${theme}.png`), animations: "disabled" });
      }
    }
    expect(errors).toEqual([]);
  });
}
for (const width of [1440, 390]) test(`Clean settings tasks separate daily rules and technical connections at ${width}px`, async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const headers = await elevatedHeaders(page);
  await page.goto("/settings");
  const original = await page.locator("html").getAttribute("data-theme");
  let settingsWrites = 0;
  page.on("request", request => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && /\/api\/v1\/(settings|ui-shell\/config|customer-agent\/.*|.*\/dial)(?:\?|$)/.test(request.url())) settingsWrites += 1;
  });
  const tasks = [
    ["agency", "company", "Компания"], ["agency", "locations", "Районы"],
    ["money", "commission", "Структура комиссии сделки"], ["money", "currency", "Курс доллара к сомони"],
    ["leads", "intake", "Свой объект: свой клиент"], ["leads", "distribution", "Распределение лидов"], ["leads", "deadlines", "Бездействие по клиенту"],
    ["matching", "matching", "Автоподбор"], ["team", "people", "Люди"], ["team", "rating", "Royal Score — рубильник модуля"],
    ["channels", "messengers", "WhatsApp, Instagram и Messenger через Meta"], ["channels", "publishing", "Обложки для соцсетей"],
    ["channels", "advertising", "Расходы по объектам"], ["channels", "phone", "Подключение к станции (ARI)"], ["channels", "sms", "СМС через Payom"],
    ["bot", "operation", "Рубильник и каналы"], ["bot", "answers", "Как продавать"], ["bot", "voice", "Живой голос по телефону"],
    ["bot", "learning", "Манеры продажи"], ["bot", "models", "Ключи моделей"], ["bot", "rollout", "Текстовый агент клиентов"],
    ["system", "monitoring", "Здоровье системы"], ["system", "workspace", "Новый интерфейс CRM"],
    ["system", "security", "Подтверждение личности"], ["system", "data", "Точки возврата настроек"], ["system", "website", "Админка сайта royalhome.tj"],
  ];
  try { for (const theme of ["light", "night"]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== `royal-home-2026-${theme}`) await page.locator("[data-topbar-theme]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", `royal-home-2026-${theme}`);
    await page.setViewportSize({ width, height: width < 820 ? 844 : 1000 });
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: /Клиенты и правила работы/ })).toBeVisible();
    await expect.poll(() => page.getByRole("searchbox", { name: "Найти настройку", exact: true }).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    // PR1179 deliberately removed the duplicate status strip. Verify the real
    // elevation grant rather than requiring the obsolete decorative component.
    await expect(page.locator(".clean-settings-status")).toHaveCount(0);
    const grant = await page.request.get("/api/v1/auth/step-up", { headers });
    expect(grant.ok()).toBe(true); expect((await grant.json()).elevated).toBe(true);
    await page.screenshot({ path: `.scratch-clean/settings-home-after-${width}-${theme}.png` });
    for (const [tab, task, heading] of tasks) {
      await page.goto(`/settings?tab=${tab}&task=${task}`);
      await expect(page.getByRole("combobox", { name: "Раздел настроек", exact: true })).toHaveValue(tab);
      const panel = page.locator(".sset-body");
      await expect(panel.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      expect(await panel.locator("button.lk,button.lnk,.chip > button").evaluateAll(nodes => nodes.filter(node => node.checkVisibility() && !(node as HTMLButtonElement).disabled)
        .map(node => ({ name: node.getAttribute("aria-label") || node.textContent?.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
        .filter(box => box.width < 44 || box.height < 44)), `${tab}/${task}`).toEqual([]);
      await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBe(width);
      if (tab === "money") await expect(panel.getByRole("heading", { name: "Бездействие по клиенту", exact: true })).toHaveCount(0);
      if (task === "commission") await expect(panel.getByRole("heading", { name: "Сроки и лимиты по лидам", exact: true })).toHaveCount(0);
      if (task === "deadlines") {
        await expect(panel.getByRole("heading", { name: "Сроки и лимиты по лидам", exact: true })).toBeVisible();
        await expect(panel.getByRole("heading", { name: "Структура комиссии сделки", exact: true })).toHaveCount(0);
      }
      if (task === "phone") {
        await expect(panel.getByRole("heading", { name: "Обложки для соцсетей", exact: true })).toHaveCount(0);
        await page.screenshot({ path: `.scratch-clean/settings-phone-setup-after-${width}-${theme}.png` });
      }
    }
    await page.getByRole("searchbox", { name: "Найти настройку", exact: true }).fill("Бездействие по клиенту");
    await page.getByRole("link", { name: /Сроки, лимиты и возврат/ }).click();
    await expect(page).toHaveURL(/tab=leads&task=deadlines&section=/);
    const destination = page.getByRole("heading", { name: "Бездействие по клиенту", exact: true });
    await expect(destination).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/tab=system&task=website$/);
    await page.goto("/settings?tab=channels&ads=error&message=QA_CONNECTION_FAILED");
    await expect(page.getByRole("combobox", { name: "Блок настроек", exact: true })).toHaveValue("advertising");
    // Existing notice is inside the collapsed connection settings; opening it must preserve the callback result.
    await page.getByRole("button", { name: /Расходы по объектам/ }).click();
    await expect(page.getByText("QA_CONNECTION_FAILED", { exact: true })).toBeVisible();
    await page.route("**/api/v1/settings/restore-points", route => route.fulfill({ json: {
      retention: { keepCount: 20, keepDays: 30 },
      items: [{ id: "qa-readonly-point", createdAt: new Date().toISOString(), agentId: null, agentName: "Проверка навигации", reason: "update", changedFields: ["companyName"], secretsRestorable: false, changes: [] }],
    } }));
    await page.goto("/settings?tab=money&task=commission");
    await page.getByRole("combobox", { name: "Раздел настроек", exact: true }).selectOption("system");
    await expect(page.getByRole("combobox", { name: "Раздел настроек", exact: true })).toHaveValue("system");
    await page.getByRole("combobox", { name: "Блок настроек", exact: true }).selectOption("data");
    await expect(page).toHaveURL(/tab=system&task=data$/);
    await expect(page.getByRole("heading", { name: "Точки возврата настроек", exact: true })).toBeVisible();
    await page.unroute("**/api/v1/settings/restore-points");
  }} finally {
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (await page.locator("html").getAttribute("data-theme") !== original) await page.locator("[data-topbar-theme]:visible").first().click();
  }
  expect(settingsWrites).toBe(0);
});
for (const width of [1440, 390]) test(`Clean commission and operations save only their own fields at ${width}px`, async ({ page }) => {
  await login(page);
  const headers = await elevatedHeaders(page);
  const response = await page.request.get("/api/v1/settings", { headers });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const attempted: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/settings", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    attempted.push(route.request().postDataJSON() as Record<string, unknown>);
    // Acknowledged locally only: never forward settings writes to the seed server.
    return route.fulfill({ json: snapshot });
  });
  await page.setViewportSize({ width, height: width < 820 ? 844 : 1000 });
  await page.goto("/settings?tab=money&task=commission");
  let form = page.locator(".sset-body form").first();
  await expect(form.getByLabel("Кто продал (риелтор), %", { exact: true })).toHaveValue(String(snapshot.commissionRealtorPercent));
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => attempted.length).toBe(1);
  expect(Object.keys(attempted[0]).sort()).toEqual(["commissionCompanyPercent", "commissionRealtorPercent", "monthlyCommissionPlan"].sort());
  expect(attempted[0].monthlyCommissionPlan).toBe(Number(snapshot.monthlyCommissionPlan));
  await page.goto("/settings?tab=leads&task=deadlines");
  form = page.locator(".sset-body form").first();
  // This native label also contains its explanatory text; match the visible name prefix.
  await expect(form.getByRole("spinbutton", { name: /^Лимит активных лидов/ })).toHaveValue(String(snapshot.leadActiveLimit));
  await expect(form.getByRole("heading", { name: "Структура комиссии сделки", exact: true })).toHaveCount(0);
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => attempted.length).toBe(2);
  expect(Object.keys(attempted[1]).sort()).toEqual([
    "leadAcceptMinutes", "leadCallMinutes", "leadCallMinSeconds", "leadActiveLimit", "propertyActiveLimit", "hotScoreThreshold",
    "propertyReviewDays", "propertyPhotoDays", "propertyVideoDays", "propertyEditingDays", "leadMaxTransfers", "dealReservationBusinessDays", "leadReassignOnMissedCallEnabled",
  ].sort());
  expect(attempted[1].leadActiveLimit).toBe(Number(snapshot.leadActiveLimit));
  expect(attempted[1]).not.toHaveProperty("monthlyCommissionPlan");
});
