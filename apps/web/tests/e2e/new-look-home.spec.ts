import { test, expect, type Browser, type Page } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";
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
/** Роли главной; вход — общий для e2e `pages/roleAuth.ts` (сессия на диске, повтор по отсчёту). */
const ROLES = ["EDITOR", "MARKETING", "SECURITY", "MANAGER", "SHAREHOLDER"] as const satisfies readonly RoleName[];
type Role = (typeof ROLES)[number];

async function roleContext(browser: Browser, role: Role, baseURL: string | undefined) {
  return contextForRole(browser, role, { baseURL, serviceWorkers: "block" });
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

for (const role of ROLES) {
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
