import { test, expect, type Page } from "@playwright/test";

/**
 * «НОВЫЙ ВИД», РАЗДЕЛ «КЛИЕНТЫ» — сторож вёрстки (пачка clients, 18.11.2026).
 *
 * Ответ /ui-shell подменяется, как в new-look.spec.ts: правило сервера
 * проверяют тесты API. Здесь — сам экран: список и карточка клиента на девяти
 * ширинах без горизонтальной прокрутки, ряд действий карточки (в макете он
 * вылезал за край на ПК и на 320–360) целиком в окне, без признака новой
 * разметки нет.
 */
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];

async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

/**
 * Элементы, вылезшие за окно ИЛИ обрезанные краем своей карточки (overflow:hidden
 * прячет вылет от scrollWidth — так и выглядела ошибка макета: кнопку «Показ»
 * просто не было видно; рамка Clean ещё и прокручивается сама, поэтому
 * scrollWidth страницы вылета не видит). Не вылет — только задуманные ленты с
 * прокруткой: вкладки карточки и ряды фильтров.
 */
const STRIPS = ".ry-ctabs, .rh-filters-scroll";
async function sticksOut(page: Page, selector: string) {
  return page.evaluate(([sel, strips]) => [...document.querySelectorAll(sel)].filter((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return false;
    if (node.parentElement?.closest(strips)) return false;
    let limit = window.innerWidth;
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== "visible") limit = Math.min(limit, p.getBoundingClientRect().right);
    }
    return rect.right > limit + 1;
  }).map((node) => `${node.tagName.toLowerCase()}.${String((node as HTMLElement).className).slice(0, 40)}`), [selector, STRIPS] as const);
}

async function noHorizontalScroll(page: Page, width: number, selector: string) {
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { message: `горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
  expect(await sticksOut(page, selector), `элементы шире окна на ${width}px`).toEqual([]);
}

test("новый вид: список и карточка клиента без вылета за край на всех ширинах @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/clients");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  const firstRow = page.locator(".ry-crow").first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  for (const width of WIDTHS) await noHorizontalScroll(page, width, ".ry-clients-head, .ry-crow, .ry-crow *, #clients-list");

  await page.setViewportSize({ width: 1440, height: 900 });
  await firstRow.locator("a.ry-crow-main").click();
  await expect(page.locator(".ry-ctabs [role=tab]").first()).toBeVisible({ timeout: 30_000 });
  for (const width of WIDTHS) {
    await noHorizontalScroll(page, width, ".clean-client-header, .clean-client-header .acts > *, .cd-actbar > *, .ry-ctabs");
  }
});

test("без признака с сервера список клиентов в прежнем виде", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/clients");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator("[data-client-row]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ry-crow, .ry-clients-head")).toHaveCount(0);
});
