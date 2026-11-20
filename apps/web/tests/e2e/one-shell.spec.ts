import { test, expect, type Browser, type Page } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";

/**
 * ОДНА ОБОЛОЧКА «НОВОГО ВИДА» — сторож раскладки по ширинам (пачка B, 20.11.2026).
 *
 * Конституция оболочки (docs/design/oblik-2026-11-17/audit-20-11/critic-uiux.md §7):
 *   320–767   нижнее меню с подписями;
 *   768–1023  рейка слева, у каждого пункта подпись;
 *   1024+     боковое меню С ПОДПИСЯМИ, не больше восьми главных пунктов (остальное в
 *             группах), нижнего меню нет;
 *   1440+     содержимое по центру свободного места, без пустоты на пол-экрана.
 * Везде: нет горизонтальной прокрутки, содержимое не уходит под меню.
 *
 * И главное правило пачки: при «Новом виде» агент на телефоне и планшете видит новый
 * вид, а не прежний телефонный интерфейс (MobileAgentHome, components/mobile/*):
 * признак вида один на все устройства (hooks/shellDevicePolicy.ts).
 *
 * Планшет и телефон — с пальцем (hasTouch), как в руке: именно у них раньше
 * раскладку решало устройство, и планшет получал телефон.
 */
const WIDTHS = [
  { width: 320, height: 640, touch: true },
  { width: 390, height: 844, touch: true },
  { width: 768, height: 1024, touch: true },
  { width: 1024, height: 768, touch: false },
  { width: 1440, height: 900, touch: false },
  { width: 1920, height: 1080, touch: false },
] as const;

// Один вход на роль за прогон: параллельные входы одной ролью упираются в паузу
// повторного кода (60 с) и роняют тест по таймауту, а не по вёрстке.
test.describe.configure({ mode: "serial" });

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type ShellAnswer = { delayMs?: number; abort?: boolean };

/**
 * Страница роли с подменённым ответом `/ui-shell` («Новый вид»).
 * `rememberGrant` — устройство помнит выданный вид (так телефон агента ждёт ответа
 * и включает вид сразу, а не со следующего запуска: ревью #329).
 */
async function royalPage(browser: Browser, role: RoleName, w: (typeof WIDTHS)[number], { rememberGrant = true, answer = {} as ShellAnswer } = {}) {
  const context = await contextForRole(browser, role, {
    viewport: { width: w.width, height: w.height }, hasTouch: w.touch, isMobile: w.touch,
    ...(w.touch ? { userAgent: PHONE_UA } : {}), serviceWorkers: "block",
  });
  await context.addInitScript((remember) => {
    // Плавающая подсказка «Поставьте CRM на экран» — не предмет этого сторожа.
    try { localStorage.setItem("rh-install-hint-dismissed", String(Date.now())); } catch { /* нет хранилища */ }
    try {
      const id = (JSON.parse(localStorage.getItem("royal-home-auth") ?? "{}") as { state?: { agent?: { id?: string } } }).state?.agent?.id;
      if (id && remember && !sessionStorage.getItem("e2e-grant-set")) {
        localStorage.setItem(`rh-look-granted:${id}`, "1");
        sessionStorage.setItem("e2e-grant-set", "1");
      }
    } catch { /* нет хранилища */ }
  }, rememberGrant);
  const page = await context.newPage();
  await page.route("**/api/v1/ui-shell", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (answer.abort) return route.abort("connectionrefused");
    return route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } });
  });
  return { context, page };
}

type Geometry = Awaited<ReturnType<typeof measure>>;
function measure(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden" || r.width === 0 || r.height === 0 ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const visibleText = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8 && getComputedStyle(el).visibility !== "hidden" ? el.textContent?.trim() ?? "" : ""; };
    const bottomNav = document.querySelector("nav[data-bottomnav]");
    const side = document.querySelector(".clean-tabs");
    const main = document.querySelector("main#main");
    const viewport = document.documentElement.clientWidth;
    const frame = document.querySelector(".clean-frame");
    return {
      look: document.documentElement.dataset.uiLook ?? null,
      viewport,
      docScroll: document.documentElement.scrollWidth - viewport,
      frameScroll: frame ? frame.scrollWidth - frame.clientWidth : 0,
      bottomNav: box(bottomNav),
      bottomTabs: bottomNav ? [...bottomNav.querySelectorAll(".sh-tab")].filter((t) => box(t)).map((t) => visibleText(t.querySelector("[data-tab-label]") ?? t)) : [],
      side: box(side),
      // Главные пункты — прямые потомки меню; пункты групп внутри <details>.
      sidePrimary: side ? [...side.querySelectorAll(":scope > .clean-tab")].filter((t) => box(t)).map((t) => visibleText(t.querySelector(".ry-nav-label") ?? t)) : [],
      sideGroups: side ? [...side.querySelectorAll(":scope > details > summary")].filter((t) => box(t)).map((t) => visibleText(t)) : [],
      main: box(main),
      mainPadBottom: main ? parseFloat(getComputedStyle(main).paddingBottom) : 0,
      // Прежний телефонный интерфейс агента: его главная (.mh) и своя нижняя панель без .sh-tabbar.
      legacyAgent: !!document.querySelector(".mh") || !!document.querySelector("nav[data-bottomnav]:not(.sh-tabbar)"),
    };
  });
}

function expectLayout(g: Geometry, width: number, label: string) {
  expect(g.look, `${label}: новый вид включён`).toBe("royal");
  expect(g.legacyAgent, `${label}: прежний телефонный интерфейс агента не рисуется`).toBe(false);
  expect(g.docScroll, `${label}: нет горизонтальной прокрутки страницы`).toBeLessThanOrEqual(1);
  expect(g.frameScroll, `${label}: нет горизонтальной прокрутки рамки`).toBeLessThanOrEqual(1);
  expect(g.main, `${label}: содержимое видно`).not.toBeNull();
  const main = g.main!;
  if (width < 768) {
    expect(g.bottomNav, `${label}: нижнее меню`).not.toBeNull();
    expect(g.side, `${label}: бокового меню нет`).toBeNull();
    expect(g.bottomTabs.length, `${label}: пункты нижнего меню`).toBeGreaterThanOrEqual(3);
    for (const text of g.bottomTabs) expect(text.length, `${label}: подпись пункта нижнего меню`).toBeGreaterThan(1);
    // Содержимое не прячется под меню: запас снизу не меньше высоты меню.
    expect(g.mainPadBottom, `${label}: запас под нижним меню`).toBeGreaterThanOrEqual(g.bottomNav!.height);
  } else if (width < 1024) {
    const rail = g.bottomNav;
    expect(rail, `${label}: рейка слева`).not.toBeNull();
    expect(rail!.left, `${label}: рейка у левого края`).toBeLessThanOrEqual(1);
    expect(rail!.width, `${label}: рейка узкая`).toBeLessThanOrEqual(110);
    expect(rail!.height, `${label}: рейка во всю высоту`).toBeGreaterThan(400);
    expect(g.side, `${label}: бокового меню нет`).toBeNull();
    expect(g.bottomTabs.length, `${label}: пункты рейки`).toBeGreaterThanOrEqual(4);
    for (const text of g.bottomTabs) expect(text.length, `${label}: подпись пункта рейки`).toBeGreaterThan(1);
    expect(main.left, `${label}: содержимое правее рейки`).toBeGreaterThanOrEqual(rail!.right - 1);
  } else {
    expect(g.side, `${label}: боковое меню`).not.toBeNull();
    // Нижнего меню нет; на сенсорном планшете от него остаётся только круглая «+».
    expect(g.bottomTabs, `${label}: пунктов нижнего меню нет`).toEqual([]);
    if (g.bottomNav) expect(g.bottomNav.width, `${label}: от нижнего меню — только «+»`).toBeLessThanOrEqual(80);
    expect(g.side!.width, `${label}: меню с подписями, а не рейка значков`).toBeGreaterThanOrEqual(200);
    expect(g.sidePrimary.length, `${label}: главные пункты`).toBeGreaterThanOrEqual(4);
    expect(g.sidePrimary.length, `${label}: не больше восьми главных пунктов`).toBeLessThanOrEqual(8);
    for (const text of [...g.sidePrimary, ...g.sideGroups]) expect(text.length, `${label}: подпись пункта меню`).toBeGreaterThan(1);
    expect(main.left, `${label}: содержимое правее меню`).toBeGreaterThanOrEqual(g.side!.right - 1);
    if (width >= 1440) {
      // По центру свободного места справа от меню (рамка даёт поровну по 32 px).
      const leftGap = main.left - g.side!.right;
      const rightGap = g.viewport - main.right;
      expect(Math.abs(leftGap - rightGap), `${label}: содержимое по центру (${leftGap} / ${rightGap})`).toBeLessThanOrEqual(24);
      expect(rightGap, `${label}: справа нет пустоты на пол-экрана`).toBeLessThan(g.viewport / 4);
    }
  }
}

for (const role of ["DIRECTOR", "AGENT"] as const) {
  test(`одна оболочка: ${role} — меню, подписи и край на шести ширинах @smoke`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины и устройства перебираются в десктопном проекте");
    test.setTimeout(180_000);
    for (const w of WIDTHS) {
      const { context, page } = await royalPage(browser, role, w);
      try {
        for (const path of ["/", "/clients"]) {
          await page.goto(path);
          await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
          await expect(page.locator("main#main")).toBeVisible();
          await page.waitForLoadState("networkidle").catch(() => {});
          expectLayout(await measure(page), w.width, `${role} ${path} ${w.width}${w.touch ? " (палец)" : ""}`);
        }
      } finally {
        await context.close();
      }
    }
  });
}

test("одна оболочка: сенсорный планшет 1100 px получает боковое меню, а не телефон", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "устройство задаётся в десктопном проекте");
  test.setTimeout(90_000);
  const { context, page } = await royalPage(browser, "DIRECTOR", { width: 1100, height: 820, touch: true } as unknown as (typeof WIDTHS)[number]);
  try {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-mobile-ux", "1");
    await expect(page.locator("main#main")).toBeVisible();
    expectLayout(await measure(page), 1100, "DIRECTOR / 1100 (палец)");
    // Нижнего меню нет, но «+» с быстрыми действиями остаётся (ревью #329).
    const fab = page.locator("nav[data-bottomnav] [data-fab]");
    await expect(fab).toBeVisible();
    await fab.click();
    await expect(page.getByRole("menu", { name: "Быстрые действия" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("одна оболочка: группа бокового меню раскрывается и ведёт в раздел", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "боковое меню — на ПК");
  test.setTimeout(90_000);
  const { context, page } = await royalPage(browser, "DIRECTOR", WIDTHS[4]);
  try {
    await page.goto("/");
    const group = page.locator(".clean-tabs > details").first();
    await expect(group).toBeVisible();
    const link = group.locator("a.clean-tab").first();
    await expect(link).toBeHidden();
    await group.locator("summary").click();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    // Открытый раздел держит свою группу раскрытой.
    await expect(page.locator(".clean-tabs > details[open] a[aria-current='page']")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("телефон агента: без запомненного вида не ждёт /ui-shell и не меняет оболочку посреди работы", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "устройство задаётся в десктопном проекте");
  test.setTimeout(90_000);
  const { context, page } = await royalPage(browser, "AGENT", WIDTHS[1], { rememberGrant: false, answer: { delayMs: 6_000 } });
  try {
    const started = Date.now();
    await page.goto("/");
    // Первый экран — прежний телефонный интерфейс, без ожидания сервера (ответ идёт 6 с,
    // в пределах таймаута запроса 8 с — иначе он не пришёл бы вовсе).
    await expect(page.locator("main#main")).toBeVisible({ timeout: 5_000 });
    expect(Date.now() - started, "экран не ждал ответа /ui-shell").toBeLessThan(5_500);
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    // Ответ с видом пришёл — экран не перестраивается, вид запомнен до следующего запуска.
    await page.waitForTimeout(8_000);
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    const remembered = await page.evaluate(() => {
      const id = (JSON.parse(localStorage.getItem("royal-home-auth") ?? "{}") as { state?: { agent?: { id?: string } } }).state?.agent?.id;
      return localStorage.getItem(`rh-look-granted:${id}`);
    });
    expect(remembered).toBe("1");
    // Следующий запуск — сразу новый вид.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
  } finally {
    await context.close();
  }
});

test("телефон агента: сбой /ui-shell при запомненном виде не вешает экран", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "устройство задаётся в десктопном проекте");
  test.setTimeout(60_000);
  const { context, page } = await royalPage(browser, "AGENT", WIDTHS[1], { answer: { abort: true } });
  try {
    await page.goto("/");
    await expect(page.locator("main#main")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  } finally {
    await context.close();
  }
});
