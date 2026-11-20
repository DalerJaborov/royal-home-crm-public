import fs from "node:fs";
import path from "node:path";
import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — главная остальных ролей на ядре блоков (пачка home, 20.11.2026).
 *
 * Монтажёр, маркетинг, СБ, менеджер и акционер входят кодом стенда
 * (LOGIN_CODE_DEV_ECHO=1, телефоны сида); признак вида и длинные данные подменены
 * (helpers ниже): на девяти ширинах нет горизонтальной прокрутки, ничего не вылезает за
 * край карточки, текст с данными не режется многоточием. Без признака у тех же ролей
 * метки раздела home нет — прежняя главная цела.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:4000";
const PHONES = { EDITOR: "+992900000006", MARKETING: "+992900000005", SECURITY: "+992900000007", MANAGER: "+992900000004", SHAREHOLDER: "+992900000009" } as const;
type Role = keyof typeof PHONES;

/** Вход один раз на роль в процессе: у входа по коду есть ограничитель попыток. */
const sessions = new Map<Role, { storageState: Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>["storageState"]>>; agent: unknown }>();

async function roleContext(browser: Browser, role: Role, baseURL: string | undefined) {
  const cached = sessions.get(role) ?? await savedOrLogin(role);
  sessions.set(role, cached);
  const context = await browser.newContext({ baseURL, storageState: cached.storageState, serviceWorkers: "block" });
  // Тот же признак сессии, что кладёт само приложение после входа (store/auth.ts).
  await context.addInitScript((a) => {
    localStorage.setItem("royal-home-auth", JSON.stringify({ state: { agent: a, hasSession: true }, version: 1 }));
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("rh:passkey-offer-dismissed", "1");
  }, cached.agent);
  return context;
}

/**
 * Вход роли переживает прогон (20.11.2026). Кэш в памяти живёт один процесс, а сервер
 * выдаёт не больше пяти кодов на сотрудника в час (LOGIN_SMS_PER_HOUR): второй-третий
 * прогон @smoke подряд на том же стенде падал на «Слишком много кодов за час» при
 * исправной главной. Сохранённую сессию проверяем обменом refresh-cookie (она
 * одноразовая — новую сразу пишем обратно); не годится — входим кодом заново.
 */
async function savedOrLogin(role: Role) {
  const file = path.join("playwright/.auth", `home-${role.toLowerCase()}.json`);
  const headers = { "X-Device-Id": `e2e-home-${role.toLowerCase()}` };
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Awaited<ReturnType<typeof login>>;
    const api = await request.newContext({ baseURL: API, storageState: saved.storageState });
    const refreshed = await api.post("/api/v1/auth/refresh", { headers }).catch(() => null);
    if (refreshed?.ok()) {
      const fresh = { storageState: await api.storageState(), agent: saved.agent };
      fs.writeFileSync(file, JSON.stringify(fresh));
      await api.dispose();
      return fresh;
    }
    await api.dispose();
  }
  const fresh = await login(role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fresh));
  return fresh;
}

async function login(role: Role) {
  const api = await request.newContext({ baseURL: API });
  const headers = { "X-Device-Id": `e2e-home-${role.toLowerCase()}` };
  // Параллельный тест той же роли мог только что попросить код: ждём таймер повтора и пробуем снова.
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

const LONG = "Очень длинное название объекта с адресом, этажом и ориентиром рядом с рынком";
const NAME = "Шахризода Абдурахмонзода-Кароматуллоева";
const stage = (overdue: boolean) => ({ inPipeline: true, owner: "EDITOR", daysInStage: 9, limitDays: 2, overdue });
const property = (i: number, status: string, overdue = i % 2 === 0) => ({
  id: `p${i}`, shortId: 900 + i, title: `${LONG} №${i}`, status, photoCount: 14, photos: [],
  responsibleAgent: { id: "ag", fullName: NAME }, pipeline: stage(overdue), instagramUrl: i === 1 ? "https://example.com" : null,
  reviewRejectionReason: i === 2 ? "Фото тёмные, нет вида из окна и подъезда, переснять при дневном свете" : null, videoHandoffQueuePosition: null,
});

async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/marketing/editor-queue", (r) => r.fulfill({ json: {
    inEditing: [1, 2, 3, 4, 5, 6].map((i) => property(i, "EDITING")), upcoming: [7, 8].map((i) => property(i, "AWAITING_VIDEO")),
    counts: { inEditing: 6, overdue: 3, upcoming: 2 }, editingPage: 1, upcomingPage: 1, pageSize: 50,
  } }));
  await page.route((u) => u.pathname === "/api/v1/marketing/summary", (r) => r.fulfill({ json: { total: 123, awaitingReview: 14, awaitingPhotos: 25, awaitingVideo: 31, editing: 6, overdue: 9 } }));
  await page.route((u) => u.pathname === "/api/v1/marketing/queue", (r) => r.fulfill({ json: {
    items: [1, 2, 3, 4, 5, 6, 7].map((i) => property(i, i % 3 === 0 ? "PENDING_REVIEW" : "AWAITING_PHOTOS")), total: 7, page: 1, pageSize: 40,
  } }));
  await page.route((u) => u.pathname === "/api/v1/dashboard/team-live", (r) => r.fulfill({ json: {
    agents: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `g${i}`, fullName: `${NAME} ${i}`, avatarUrl: null, activeLoad: i, pendingAccept: i % 2, acceptedToday: 12, escalated: i === 3 ? 4 : 0 })),
    unaccepted: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ shortId: 500 + i, fullName: `${NAME} клиент ${i}`, agentName: NAME, reassignCount: i, escalated: i % 2 === 1, lost: i === 6, waitingMinutes: 120 + i })),
    unacceptedTotal: 7, escalatedTotal: 3, queuedTotal: 12,
  } }));
}

const CHECK = ["[data-ry-section=\"home\"] .ry-tile", "[data-ry-section=\"home\"] .ry-row", "[data-ry-section=\"home\"] .ry-home-q",
  "[data-ry-section=\"home\"] .ry-home-chip", "[data-ry-section=\"home\"] .ry-home-hint", "[data-ry-section=\"home\"] .ry-home-ask button",
  "[data-ry-section=\"home\"] .ry-section-head"].join(", ");

for (const role of Object.keys(PHONES) as Role[]) {
  test(`новый вид, главная ${role}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
    test.setTimeout(360_000);
    const context = await roleContext(browser, role, baseURL);
    const page = await context.newPage();
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator('.ry-today[data-ry-section="home"] .ry-section').first()).toBeVisible({ timeout: 30_000 });
      // График по месяцам листается внутри своей карточки (задуманная лента).
      await expectNoOverflowAt(page, width, CHECK, { strips: ".rh2-bar-chart", textRoot: '[data-ry-section="home"]' });
    }
    await context.close();
  });
}

test("новый вид, главная: срочная плашка тёмная и сплошная, внимание светлое", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(180_000);
  const context = await roleContext(browser, "MANAGER", baseURL);
  const page = await context.newPage();
  await stub(page, true);
  await page.goto("/");
  const chip = (tone: string) => page.locator(`[data-ry-section="home"] .ry-home-chip[data-tone="${tone}"]`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(page.locator('[data-ry-section="home"] .ry-home-chip[data-tone="crit"]').first()).toBeVisible({ timeout: 30_000 });
  const lum = (rgb: string) => { const [r, g, b] = rgb.match(/[\d.]+/g)!.map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  expect(lum(await chip("warn")) - lum(await chip("crit"))).toBeGreaterThan(80);
  await context.close();
});

test("без признака у ролей нет метки раздела home — прежняя главная цела", async ({ browser, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.skip(!/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL ?? ""), "только стенд с сидом");
  test.setTimeout(240_000);
  for (const role of ["SECURITY", "SHAREHOLDER"] as const) {
    const context = await roleContext(browser, role, baseURL);
    const page = await context.newPage();
    await stub(page, false);
    await page.goto("/");
    // Прежние главные: СБ — «Рабочие разделы», акционер — главная менеджера.
    await expect(page.getByRole("heading", { name: /Рабочие разделы|Горит сейчас/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator('[data-ry-section="home"]')).toHaveCount(0);
    await context.close();
  }
});
