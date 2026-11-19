import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";
import { backups, oversight, security, stuckWork } from "./helpers/controlFixtures";

/**
 * «НОВЫЙ ВИД» — экраны контроля (пачка control, 19.11.2026): сторож вёрстки.
 *
 * Ответы API подменяются вымышленными (helpers/controlFixtures.ts: в сиде стенда
 * срезов антифрода, вердиктов СБ, отчётов бэкапа и сдавшихся заданий нет): на девяти
 * ширинах ни один экран не даёт горизонтальной прокрутки и ничего не вылезает за край
 * карточки — длинные имена, причины и ошибки переносятся. Без признака с сервера
 * метки раздела нет (прежний вид цел).
 */
async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  const O = "/api/v1/oversight/";
  const slices: Record<string, unknown> = {
    summary: oversight.summary, "overdue-tasks": oversight.overdueTasks, "no-contact-clients": oversight.noContactClients,
    "silent-after-showing": oversight.silentAfterShowing, "seller-property-missing": oversight.sellerPropertyMissing,
    "endless-negotiations": oversight.endlessNegotiations, "refused-high-score": oversight.refusedHighScore,
    "showing-survey-calls": oversight.showingSurveyCalls, "agent-loss-series": oversight.agentLossSeries,
    "lead-transfers": oversight.leadTransfers, "transfer-pairs": oversight.transferPairs,
  };
  await page.route((u) => u.pathname.startsWith(O) && u.pathname.slice(O.length) in slices,
    (r) => r.fulfill({ json: slices[new URL(r.request().url()).pathname.slice(O.length)] }));
  await page.route((u) => u.pathname === "/api/v1/security/summary", (r) => r.fulfill({ json: security.summary }));
  await page.route((u) => u.pathname === "/api/v1/security/lost-clients", (r) => r.fulfill({ json: security.lostClients }));
  await page.route((u) => u.pathname === "/api/v1/security/cases", (r) => r.fulfill({ json: security.cases }));
  await page.route((u) => u.pathname === "/api/v1/backups", (r) => r.fulfill({ json: backups }));
  await page.route((u) => u.pathname === "/api/v1/stuck-work", (r) => r.fulfill({ json: stuckWork }));
}

const CHECK = [".ry-control .pg-h", ".ry-control .tile", ".ry-control .card", ".ry-control .quiet", ".ry-control .pcard",
  ".ry-control .list > .row", ".ry-control .pill", ".ry-control .chip", ".ry-control .bars .b"].join(", ");
const SCREENS = [
  { url: "/oversight", ready: ".ry-control .quiet.crit" },
  { url: "/security", ready: ".ry-control .pcard" },
  { url: "/health", ready: ".ry-control .tiles .tile" },
  { url: "/stuck-work", ready: ".ry-control .list > .row" },
  { url: "/backups", ready: ".ry-control .list > .row" },
  { url: "/ai-learning?tab=rules", ready: ".ry-control .tiles .tile" },
];

for (const screen of SCREENS) {
  test(`новый вид ${screen.url}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    test.setTimeout(240_000);
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(screen.url);
      // Первый заход в раздел на dev-сервере стенда компилирует модули: ждём признак дольше обычного.
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
      // Вкладки раздела (.seg-ai) и экрана (.hscroll) не исключаются: от 820 px они переносятся,
      // ниже длинная полоса раздела становится выбором (ScreenTabs) — вылезать нечему.
      await expectNoOverflowAt(page, width, `${CHECK}, .ry-control .seg-ai > a, .ry-control .hscroll .seg > button`, { strips: "" });
    }
  });
}

/**
 * Ревью PR #305: ряд вкладок раздела листался без полосы прокрутки, и на 820–1250 px
 * последние вкладки («Обучение бота», «Архив») уезжали за край — мышью до них не добраться.
 * На 1024 каждая вкладка раздела видна целиком и нажимается (в её середине — она сама).
 */
test("новый вид: последняя вкладка раздела видна и нажимается на 1024", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  test.setTimeout(90_000);
  await stub(page, true);
  await page.setViewportSize({ width: 1024, height: 800 });
  for (const url of ["/health", "/oversight", "/ai-learning"]) {
    await page.goto(url);
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
    const tabs = page.locator(url === "/ai-learning" ? ".ry-control .hscroll .seg > button" : ".ry-control .seg-ai > a");
    await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
    const last = tabs.last();
    const reachable = await last.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === "visible") continue;
        const a = p.getBoundingClientRect();
        if (r.right > a.right + 1 || r.left < a.left - 1) clipped = true;
      }
      return { inWindow: r.right <= window.innerWidth + 1 && r.left >= 0, onTop: !!hit && el.contains(hit), clipped };
    });
    expect(reachable, `${url}: последняя вкладка`).toEqual({ inWindow: true, onTop: true, clipped: false });
    await last.click({ trial: true });
  }
});

test("новый вид: срочное и внимание различаются яркостью и знаком, не только оттенком", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  await stub(page, true);
  await page.goto("/oversight");
  await expect(page.locator(".ry-control .quiet.crit").first()).toBeVisible({ timeout: 20_000 });
  const mark = (sel: string) => page.locator(sel).first().evaluate((el) => {
    const s = getComputedStyle(el, "::before");
    return { content: s.content, bg: s.backgroundColor };
  });
  const crit = await mark(".ry-control .card.tight > .quiet.crit");
  const warn = await mark(".ry-control .card.tight > .quiet.warn");
  expect(crit.content).toBe('"!"');
  expect(warn.content).toBe('"!"');
  const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  // срочный круг тёмный (сплошной красный), круг внимания светлый
  expect(lum(warn.bg) - lum(crit.bg)).toBeGreaterThan(80);
  // срочная плитка — сплошной красный круг
  const tile = await page.locator(".ry-control .tile.ry-tile-crit .ic").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tile).toMatch(/^rgb\((1[6-9]\d|2\d\d), \d{1,2}, \d{1,2}\)$/);
});

test("без признака метки раздела нет — прежний вид цел", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверяется в десктопном проекте");
  // Шесть заходов на страницы: на dev-сервере стенда дольше общего лимита 30 с.
  test.setTimeout(180_000);
  await stub(page, false);
  for (const screen of SCREENS) {
    await page.goto(screen.url);
    await expect(page.locator(".rh2.screens .scr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", "royal");
    expect(await page.locator("[data-ry-section], .ry-control").count(), screen.url).toBe(0);
  }
});
