import { test, expect, type Page } from "@playwright/test";

/**
 * ТЕЛЕФОН С ВЫРЕЗОМ (28.11.2026, владелец с iPhone): «Чаты» лежали под часами и островом,
 * «Календарь» подпрыгивал на 27 px при прокрутке, «Уведомления» были шире телефона и нижнее
 * меню вставало на y=1051 при окне 844. Сборка и юнит-тесты этого не видят: нужна отрисовка.
 *
 * ВНИМАНИЕ: это ЭМУЛЯЦИЯ. Вырез задаёт CDP `Emulation.setSafeAreaInsetsOverride` — он есть только
 * у Chromium. WebKit-проект (iPhone 13) вырез эмулировать не умеет (у Playwright нет такого
 * вызова для WebKit): там идут те же проверки с нулевым вырезом (перекрытие, рывок, ширина).
 * Настоящий iPhone проверяет владелец.
 */
const TOP = 47;
const BOTTOM = 34;
const ROUTES = ["/", "/clients", "/messages", "/team", "/more", "/calendar", "/properties", "/notifications"];

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function applyInsets(page: Page, projectName: string): Promise<number> {
  if (projectName === "webkit") return 0;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: TOP, bottom: BOTTOM, left: 0, right: 0 } });
  return TOP;
}

/** Верх первого видимого содержимого колонки экрана (не скрытый для глаз заголовок). */
function firstContentTop() {
  const main = document.querySelector(".app-main-col");
  if (!main) return null;
  for (const el of main.querySelectorAll("*")) {
    if (el.closest(".sr-only, [aria-hidden='true']")) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.height < 8 || r.width < 8 || cs.visibility === "hidden" || cs.display === "none") continue;
    return r.top + scrollY;
  }
  return null;
}

for (const width of [390, 320]) {
  test.describe(`верх экрана под вырезом, ${width} px`, () => {
    test.use({ viewport: { width, height: 844 } });

    for (const route of ROUTES) {
      test(`${route}: содержимое ниже выреза, шапка не перекрывает, прокрутка не сдвигает @smoke`, async ({ page }, testInfo) => {
        const inset = await applyInsets(page, testInfo.project.name);
        await page.goto(route);
        await expect(page.locator(".app-main-col")).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(800);

        // 1. Страница не шире телефона: иначе браузер уменьшает лист, а fixed-меню уезжает вниз.
        const size = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: innerHeight }));
        expect(size.sw, `горизонтальный лист: ${size.sw} > ${size.cw}`).toBeLessThanOrEqual(size.cw);
        expect(size.ih, "окно уменьшено содержимым шире экрана").toBe(844);

        // 2. Верх первого содержимого не выше выреза.
        const top = await page.evaluate(firstContentTop);
        expect(top, "нет видимого содержимого").not.toBeNull();
        expect(top!).toBeGreaterThanOrEqual(inset);

        // 3. Шапка оболочки (если видна) не налезает на содержимое.
        const header = await page.evaluate(() => {
          const h = document.querySelector(".clean-header");
          if (!h || getComputedStyle(h).display === "none") return null;
          return h.getBoundingClientRect().bottom + scrollY;
        });
        if (header !== null) expect(header).toBeLessThanOrEqual(top! + 1);

        // 4. Нижнее меню целиком в окне.
        const nav = await page.evaluate(() => { const n = document.querySelector("nav[data-bottomnav]"); const r = n?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; });
        if (nav) { expect(nav.bottom).toBeLessThanOrEqual(844); expect(nav.top).toBeGreaterThan(400); }

        // 5. Прокрутка не двигает содержимое: его место в документе одно и то же на любом сдвиге,
        //    а сама прокрутка встаёт ровно на заказанное (если страница достаточно длинная).
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        let doc0: number | null = null;
        for (const y of [0, 10, 13, 14, 30, 80]) {
          if (y > max) continue;
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(200);
          const state = await page.evaluate(() => {
            const m = document.querySelector(".app-main-col")!.getBoundingClientRect();
            return { y: Math.round(scrollY), doc: Math.round(m.top + scrollY) };
          });
          expect(state.y, `прокрутка на ${y} встала на ${state.y}`).toBe(y);
          doc0 ??= state.doc;
          expect(state.doc, `содержимое подпрыгнуло на прокрутке ${y}`).toBe(doc0);
        }
      });
    }
  });
}
