import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";
import { functionStatus, integrations, notifications, pendingLeads } from "./helpers/adminFixtures";

/**
 * «НОВЫЙ ВИД» — служебные экраны (пачка admin, 20.11.2026): сторож вёрстки.
 *
 * Ответы API подменяются вымышленными (helpers/adminFixtures.ts: в сиде стенда нет
 * сломанных каналов, критичных уведомлений, предложений объекта и упавших фоновых
 * задач): на девяти ширинах ни один экран не даёт горизонтальной прокрутки и ничего
 * не вылезает за край карточки — длинные имена каналов, причины и имена переменных
 * сервера переносятся. Таблица «Права по ролям» прокручивается сама (лента `.tbl-wrap`,
 * так задумано: название слева стоит на месте). Без признака метки раздела нет.
 */
async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/me/notifications", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: new URL(r.request().url()).searchParams.get("page") ? { items: [], hasMore: false } : notifications })
    : r.fallback());
  // «Принять» видно только у своего лида: id того, кто вошёл, — тем же запросом /me с его ключом.
  // Запрос идёт и с других экранов; при переходе на следующую ширину ответ может быть уже
  // отменён — тогда молча отпускаем (кэш id одного входа на весь тест).
  let meId: string | undefined;
  await page.route((u) => u.pathname === "/api/v1/clients" && u.searchParams.get("pendingAcceptance") === "1", async (r) => {
    try {
      meId ??= ((await (await r.fetch({ url: new URL("/api/v1/me", r.request().url()).href })).json()) as { id: string }).id;
      await r.fulfill({ json: { ...pendingLeads, items: pendingLeads.items.map((c) => ({ ...c, assignedAgentId: meId })) } });
    } catch { /* страница ушла дальше — ответ никому не нужен */ }
  });
  await page.route((u) => u.pathname === "/api/v1/integrations", (r) => r.fulfill({ json: integrations }));
  await page.route((u) => u.pathname === "/api/v1/function-status", (r) => r.fulfill({ json: functionStatus }));
}

const CHECK = [".ry-admin .pg-h", ".ry-admin .tile", ".ry-admin .card", ".ry-admin .ry-adm-card", ".ry-admin .ry-adm-empty",
  ".ry-admin .quiet", ".ry-admin .list > .row", ".ry-admin .mod", ".ry-admin .ry-ntf", ".ry-admin .ry-ntf-acts > *",
  ".ry-admin .pill", ".ry-admin .ry-btn", ".ry-admin .chip", ".ry-admin .fs-cron", ".ry-admin .seg > button", ".ry-admin .seg-ai > a"].join(", ");
const channel = encodeURIComponent(integrations.channels[1].name);
const SCREENS = [
  { url: "/settings/roles", ready: ".ry-admin .rmx" },
  { url: "/settings/functions", ready: ".ry-admin .row.fs-item" },
  { url: "/profile", ready: ".ry-admin .prof-h" },
  { url: "/integrations", ready: ".ry-admin .list > .row" },
  { url: `/integrations/${channel}`, ready: ".ry-admin .ry-adm-card" },
  { url: "/notifications", ready: ".ry-admin .ry-ntf" },
  { url: "/no-such-page", ready: ".ry-admin .ry-adm-empty" },
];

for (const screen of SCREENS) {
  test(`новый вид ${decodeURIComponent(screen.url)}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(screen.url);
      // Первый заход в раздел на dev-сервере стенда компилирует модули: ждём признак дольше обычного.
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
      // Текст проверяется внутри экрана: шапка оболочки (общая, не пачки) на 320 px режет
      // многоточием любое название длиннее ~10 букв — и прежний «Канал интеграции» тоже.
      await expectNoOverflowAt(page, width, CHECK, { strips: ".tbl-wrap", textRoot: ".ry-admin" });
    }
  });
}

test("новый вид: «Критичное» темнее «Ждёт решения» — яркостью и значком, не только оттенком", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  await stub(page, true);
  await page.goto("/notifications");
  await expect(page.locator(".ry-admin .ry-ntf").first()).toBeVisible({ timeout: 30_000 });
  const bg = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const crit = await bg('.ry-admin .ry-ntf .ry-circle[data-tone="crit"]');
  const warn = await bg('.ry-admin .ry-ntf .ry-circle[data-tone="warn"]');
  expect(lum(warn) - lum(crit)).toBeGreaterThan(80);
  // у срочного свой значок (пламя), у «ждёт решения» — значок повода
  const icon = (sel: string) => page.locator(sel).first().innerHTML();
  expect(await icon('.ry-admin .ry-ntf .ry-circle[data-tone="crit"]')).not.toBe(await icon('.ry-admin .ry-ntf .ry-circle[data-tone="warn"]'));
});

test("новый вид: выключенная кнопка приглушена, переключатель профиля 56 на 34", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  await stub(page, true);
  await page.goto("/profile");
  await expect(page.locator(".ry-admin .prof-h")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Вид и приложение" }).click();
  const knob = page.locator(".ry-admin .tgl i").first();
  await expect(knob).toBeVisible();
  expect(await knob.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([56, 34]);
});

test("без признака метки раздела нет — прежний вид цел", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(180_000);
  await stub(page, false);
  for (const screen of SCREENS) {
    await page.goto(screen.url);
    await expect(page.locator(".rh2 .scr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    expect(await page.locator("[data-ry-section], .ry-admin").count(), screen.url).toBe(0);
  }
});
