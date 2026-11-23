import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * «НОВЫЙ ВИД» — плавающие слои, клавиатура, шторки, ленты (аудит 20.11.2026, классы К06, К07, К08, К20).
 *  К06: плашка «Поставьте CRM на экран» — строка в экране, один раз, «Не сейчас»; конец страницы выше нижнего меню.
 *  К07: при клавиатуре нижнее меню скрыто на любом экране с полем; подвал шторки над клавиатурой, поле видно.
 *  К08: у шторки нет рамки фокуса, высота одна, повтора имени клиента внутри нет.
 *  К20: лента, которая листается вбок, гаснет у края и там, где у браузера нет `animation-timeline`.
 * Гоняется в webkit (iPhone 13) и chromium (390): клавиатуру подменяем visualViewport, как в look-chat-sheets.
 * Кадры — в SHOTS_DIR, если задан.
 */
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string, testInfo: { project: { name: string } }) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${testInfo.project.name}.png`) });
};

test.beforeEach(({}, testInfo) => {
  test.skip(!["chromium", "webkit"].includes(testInfo.project.name), "нужен проект chromium или webkit");
});
test.use({ viewport: { width: 390, height: 844 } });

async function royal(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

/** Safari при клавиатуре уменьшает visualViewport, а layout viewport оставляет: подменяем так же. */
async function fakeKeyboard(page: Page) {
  await page.addInitScript(() => {
    const listeners: Record<string, Array<() => void>> = {};
    const fake = {
      height: 844, offsetTop: 0, offsetLeft: 0, width: 390, scale: 1, pageTop: 0, pageLeft: 0,
      addEventListener: (type: string, cb: () => void) => { (listeners[type] ??= []).push(cb); },
      removeEventListener: (type: string, cb: () => void) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb); },
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    (window as unknown as { __kb: (h: number, top: number) => void }).__kb = (h, top) => {
      fake.height = h; fake.offsetTop = top;
      for (const type of ["resize", "scroll"]) for (const cb of listeners[type] ?? []) cb();
    };
  });
}
const setKb = (page: Page, h: number, top = 0) => page.evaluate(([a, b]) => (window as unknown as { __kb: (h: number, t: number) => void }).__kb(a, b), [h, top] as const);
const KB_HEIGHT = 508; // 844 − клавиатура 336
const FIELD = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"])';

async function openRoyal(page: Page, url: string) {
  await royal(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 60_000 });
  await expect(page.locator("#main")).toBeVisible();
}

/** Шторки с полем: откуда открываются. */
const SHEETS: { name: string; url: string; opener: (page: Page) => Promise<void> }[] = [
  { name: "client-result", url: "/clients/10", opener: (p) => p.getByRole("button", { name: "Записать результат" }).first().click() },
  { name: "finance-expense", url: "/finance", opener: (p) => p.getByRole("button", { name: "Расход", exact: true }).first().click() },
  { name: "ui-check", url: "/ui-check", opener: (p) => p.getByRole("button", { name: "Открыть пробную шторку" }).click() },
];

test.describe("К07: клавиатура и шторки", () => {
  for (const sheet of SHEETS) {
    test(`шторка «${sheet.name}»: меню скрыто, подвал над клавиатурой, поле видно, без клавиатуры всё возвращается @smoke`, async ({ page }, testInfo) => {
      await fakeKeyboard(page);
      await openRoyal(page, sheet.url);
      await sheet.opener(page);
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible();
      const sheetBox = dialog.locator("xpath=.");
      const field = dialog.locator(FIELD).first();
      await expect(field).toBeVisible();
      const before = await sheetBox.boundingBox();
      expect(Math.round(before!.y + before!.height), "без клавиатуры шторка стоит у низа экрана").toBeGreaterThanOrEqual(844);
      await shot(page, `${sheet.name}-1-closed-kb`, testInfo);

      await expect(async () => {
        await field.focus();
        await setKb(page, KB_HEIGHT);
        await expect(page.locator("html")).toHaveAttribute("data-kb-open", "1", { timeout: 1500 });
      }).toPass({ timeout: 15_000 });
      await expect(page.locator("nav[data-bottomnav]")).toBeHidden();
      // Шторка поднята ровно над клавиатурой, не выше экрана.
      await expect.poll(async () => {
        const b = await sheetBox.boundingBox();
        return b ? Math.round(b.y + b.height) : -1;
      }, { message: "низ шторки = верх клавиатуры" }).toBe(KB_HEIGHT);
      const raised = await sheetBox.boundingBox();
      expect(raised!.y, "верх шторки не уходит за экран").toBeGreaterThanOrEqual(0);
      const footer = dialog.locator(".sheet-f, .cef-sheet-footer");
      if ((await footer.count()) > 0) {
        const f = await footer.boundingBox();
        expect(Math.round(f!.y + f!.height), "подвал с кнопками над клавиатурой").toBeLessThanOrEqual(KB_HEIGHT);
        // Над клавиатурой нет пустой полосы с запасом под жесты iPhone: подвал прилегает к её верху.
        expect(KB_HEIGHT - Math.round(f!.y + f!.height), "пустая полоса между подвалом и клавиатурой").toBeLessThanOrEqual(sheet.name === "finance-expense" ? 20 : 2);
      }
      // Поле в фокусе остаётся в видимой части и выше подвала.
      await expect.poll(async () => {
        const b = await field.boundingBox();
        const foot = (await footer.count()) > 0 ? await footer.boundingBox() : null;
        const limit = foot ? foot.y : KB_HEIGHT;
        return b ? Math.round(b.y) >= 0 && Math.round(b.y + b.height) <= limit + 1 : false;
      }, { message: "поле в фокусе видно над подвалом", timeout: 5000 }).toBe(true);
      await shot(page, `${sheet.name}-2-keyboard`, testInfo);

      await setKb(page, 844);
      await expect(page.locator("html")).not.toHaveAttribute("data-kb-open", /.*/);
      const after = await sheetBox.boundingBox();
      expect(Math.round(after!.y + after!.height), "клавиатура закрылась — шторка снова у низа").toBeGreaterThanOrEqual(844);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator("html")).not.toHaveAttribute("data-kb-open", /.*/);
    });
  }

  test("экран с полем (не шторка): при клавиатуре нижнее меню скрыто, потом возвращается @smoke", async ({ page }, testInfo) => {
    await fakeKeyboard(page);
    await openRoyal(page, "/properties");
    const nav = page.locator("nav[data-bottomnav]");
    await expect(nav).toBeVisible();
    const field = page.locator('#main input[type="search"]').first();
    await expect(field).toBeVisible();
    await shot(page, "page-field-1-closed-kb", testInfo);
    await expect(async () => {
      await field.focus();
      await setKb(page, KB_HEIGHT);
      await expect(page.locator("html")).toHaveAttribute("data-kb-open", "1", { timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await expect(nav).toBeHidden();
    await shot(page, "page-field-2-keyboard", testInfo);
    await setKb(page, 844);
    await expect(nav).toBeVisible();
  });
});

test.describe("К08: шторки", () => {
  test("у контейнера шторки нет рамки фокуса, высота одна у всех форм, имя клиента не повторяется", async ({ page }, testInfo) => {
    await openRoyal(page, "/clients/10");
    const heights: number[] = [];
    for (const name of ["Записать результат", "Назначить показ"]) {
      await page.getByRole("button", { name }).first().click();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeFocused();
      const outline = await dialog.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { style: cs.outlineStyle, width: cs.outlineWidth };
      });
      expect(outline.style === "none" || outline.width === "0px", `${name}: рамка вокруг шторки (${JSON.stringify(outline)})`).toBe(true);
      const box = await dialog.boundingBox();
      heights.push(Math.round(box!.height));
      if (name === "Назначить показ") {
        await expect(dialog.getByText("Показ для клиента", { exact: false })).toHaveCount(0);
        await expect(dialog.locator(".clean-interaction-context")).toHaveCount(0);
      }
      await shot(page, `sheet-${name === "Записать результат" ? "result" : "showing"}`, testInfo);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    // Форма не ниже ~62% экрана (520 px): «почти на весь экран» и «на половину» больше не бывает.
    for (const h of heights) expect(h, `высоты шторок: ${heights.join(", ")}`).toBeGreaterThanOrEqual(519);
  });
});

test.describe("К06: плашка установки и конец страницы над меню", () => {
  /**
   * «Не сейчас» уходит в настройки человека НА СЕРВЕРЕ и держится там навсегда: без изоляции второй прогон на том же
   * стенде не увидел бы плашку вовсе. Запись перехватываем и возвращаем обратно только внутри одного теста.
   */
  async function isolatePrefs(page: Page) {
    let dismissed: string[] = [];
    await page.route((url) => url.pathname === "/api/v1/me/preferences", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      try { dismissed = (route.request().postDataJSON() as { dismissedHints?: string[] }).dismissedHints ?? dismissed; } catch { /* не JSON */ }
      return route.fulfill({ json: {} });
    });
    await page.route((url) => url.pathname === "/api/v1/me", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = await response.json().catch(() => null) as { preferences?: Record<string, unknown> } | null;
      if (body?.preferences) body.preferences.dismissedHints = dismissed;
      return route.fulfill({ response, json: body });
    });
  }

  // Перехваты /me живут дольше теста (перезагрузка страницы): без снятия они падают «Test ended».
  test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

  async function offerInstall(page: Page) {
    await isolatePrefs(page);
    await page.addInitScript(() => {
      try { if (!sessionStorage.getItem("e2e-visits")) { localStorage.setItem("rh-visit-count", "2"); sessionStorage.setItem("e2e-visits", "1"); } } catch { /* нет хранилища */ }
    });
    await royal(page);
    await page.goto("/");
    await expect(page.locator("#main")).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
      await expect(page.getByRole("region", { name: "Установка CRM на экран телефона" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  }

  test("плашка — строка в экране, не плавает над меню; «Не сейчас» запоминается @smoke", async ({ page }, testInfo) => {
    await offerInstall(page);
    const hint = page.getByRole("region", { name: "Установка CRM на экран телефона" });
    const geometry = await hint.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      let floating = false;
      while (node && node !== document.body) {
        const p = getComputedStyle(node).position;
        if (p === "fixed" || p === "sticky") floating = true;
        node = node.parentElement;
      }
      const nav = document.querySelector("nav[data-bottomnav]")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { floating, hintBottom: box.bottom, navTop: nav.top };
    });
    expect(geometry.floating, "плашка не должна быть fixed/sticky").toBe(false);
    expect(geometry.hintBottom).toBeLessThanOrEqual(geometry.navTop);
    await shot(page, "install-hint", testInfo);
    await page.getByRole("button", { name: "Не сейчас" }).click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#main")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
    await page.waitForTimeout(800);
    await expect(page.getByRole("region", { name: "Установка CRM на экран телефона" })).toHaveCount(0);
  });

  test("не предлагается второй раз, если её уже показывали", async ({ page }) => {
    await offerInstall(page);
    await page.reload();
    await expect(page.locator("#main")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
    await page.waitForTimeout(800);
    await expect(page.getByRole("region", { name: "Установка CRM на экран телефона" })).toHaveCount(0);
  });

  const ROUTES = ["/", "/clients", "/finance", "/properties"];
  for (const width of [320, 390, 430]) {
    for (const route of ROUTES) {
      test(`${route} на ${width} px: конец страницы выше нижнего меню`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        await openRoyal(page, route);
        await page.waitForTimeout(1500);
        // Списки подгружаются при докрутке до низа: крутим, пока высота страницы не перестанет расти.
        for (let i = 0, last = -1; i < 8; i++) {
          const height = await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); return document.documentElement.scrollHeight; });
          await page.waitForTimeout(600);
          if (height === last) break;
          last = height;
        }
        const g = await page.evaluate(() => {
          const nav = document.querySelector("nav[data-bottomnav]")!.getBoundingClientRect();
          const main = document.querySelector("#main")!;
          let end = 0;
          const floating = (el: Element) => {
            for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
              const p = getComputedStyle(n).position;
              if (p === "fixed" || p === "sticky") return true;
            }
            return false;
          };
          for (const el of main.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || floating(el)) continue;
            if (getComputedStyle(el).visibility === "hidden") continue;
            end = Math.max(end, r.bottom);
          }
          return { navTop: Math.round(nav.top), contentEnd: Math.round(end), vh: innerHeight };
        });
        expect(g.contentEnd, `${route} ${width}: низ содержимого ${g.contentEnd}, верх меню ${g.navTop}`).toBeLessThanOrEqual(g.navTop);
        if (width === 390) await shot(page, `end-of-page${route === "/" ? "-home" : route.replace("/", "-")}`, testInfo);
      });
    }
  }
});

test.describe("К20: ленты, которые листаются, гаснут у края", () => {
  test("вкладки «Деньги» и карточки клиента: у края видно, что дальше есть ещё", async ({ page }, testInfo) => {
    for (const [url, selector] of [["/finance", ".cef-main-tabs"], ["/clients/10", ".ry-ctabs"]] as const) {
      await openRoyal(page, url);
      const strip = page.locator(selector).first();
      await expect(strip).toBeVisible({ timeout: 30_000 });
      const overflow = await strip.evaluate((el) => el.scrollWidth - el.clientWidth);
      if (overflow <= 4) continue; // всё поместилось — гасить нечего
      await expect.poll(() => strip.evaluate((el) => {
        const cs = getComputedStyle(el);
        const mask = cs.maskImage || cs.webkitMaskImage || "none";
        return mask !== "none";
      }), { message: `${url}: у ленты ${selector} нет затухания`, timeout: 5000 }).toBe(true);
      await shot(page, `strip${url.replace(/\//g, "-")}`, testInfo);
      await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      await expect.poll(() => strip.evaluate((el) => el.getAttribute("data-strip-more") ?? "none")).not.toBe("end");
    }
  });
});
