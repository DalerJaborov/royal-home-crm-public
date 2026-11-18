import { test, expect, type Page } from "@playwright/test";

/**
 * «НОВЫЙ ВИД», пачка debt (18.11.2026): долги, уже выкаченные одному администратору.
 *
 *  1. Шапка оболочки непрозрачна: прокрученный текст не проходит под поиском,
 *     колокольчиком и именем (6 экранов, ПК и телефон).
 *  2. В настоящем браузере, против ВСЕХ старых тем: выключенная кнопка раздела
 *     приглушена (opacity .5), в том числе красная и серая, а красная остаётся красной —
 *     так проверяется не эвристика сторожа CSS, а итог каскада. (У .warn/.ok/.hot своего
 *     цвета кнопки в старой теме нет — сравнивать нечего; их держит сторож CSS.)
 *  3. Подписи групп настроек — короткие, без склейки подразделов.
 *  4. Плашка «Уведомления заблокированы браузером» переносится, а не обрезается.
 */
async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

/** Прокрутить то, что на экране прокручивается (рамка оболочки на ПК или документ), и проверить шапку. */
async function headerCoversContent(page: Page) {
  return page.evaluate(async () => {
    const header = document.querySelector<HTMLElement>(".clean-header");
    if (!header || header.getBoundingClientRect().height === 0) return { ok: true, why: "шапки нет" };
    for (const el of [document.querySelector(".clean-frame"), document.scrollingElement]) if (el) el.scrollTop += 600;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bg = getComputedStyle(header).backgroundColor;
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(bg)?.[1];
    if (bg === "transparent" || (alpha !== undefined && Number(alpha) < 1)) return { ok: false, why: `фон шапки ${bg}` };
    // Каждая точка шапки принадлежит шапке (или тому, что над ней закреплено), а не тексту экрана под ней.
    const rect = header.getBoundingClientRect();
    for (const x of [rect.left + 8, rect.left + rect.width / 3, rect.left + rect.width / 2]) {
      for (const y of [rect.top + 6, rect.top + rect.height / 2, rect.bottom - 3]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && !hit.closest(".clean-header, .clean-brand, .clean-tabs, [role=dialog], .sheet")) {
          return { ok: false, why: `в шапке (${Math.round(x)},${Math.round(y)}) виден ${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 40)}` };
        }
      }
    }
    return { ok: true, why: "" };
  });
}

async function openClientCard(page: Page) {
  await page.goto("/clients");
  const row = page.locator(".ry-crow a.ry-crow-main").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator(".clean-client-detail").first()).toBeVisible({ timeout: 30_000 });
}

const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: "главная", open: async (page) => { await page.goto("/"); await expect(page.locator("main#main")).toBeVisible({ timeout: 30_000 }); } },
  { name: "клиенты", open: async (page) => { await page.goto("/clients"); await expect(page.locator(".ry-crow").first()).toBeVisible({ timeout: 30_000 }); } },
  { name: "карточка клиента", open: openClientCard },
  { name: "чаты", open: async (page) => { await page.goto("/messages"); await expect(page.locator('[data-ry-section="chats"]').first()).toBeVisible({ timeout: 30_000 }); } },
  { name: "объекты", open: async (page) => { await page.goto("/properties"); await expect(page.locator('[data-ry-section="objects"]').first()).toBeVisible({ timeout: 30_000 }); } },
  { name: "настройки", open: async (page) => { await page.goto("/settings"); await expect(page.locator(".ry-set").first()).toBeVisible({ timeout: 30_000 }); } },
];

for (const size of [{ label: "ПК", width: 1440, height: 900 }, { label: "телефон", width: 390, height: 844 }]) {
  test(`новый вид debt: шапка непрозрачна при прокрутке — ${size.label}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "размер окна задаётся явно");
    await withShell(page, { enabled: true, look: "royal" });
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const screen of SCREENS) {
      await screen.open(page);
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
      const result = await headerCoversContent(page);
      expect(result.ok, `${screen.name}, ${size.label}: ${result.why}`).toBe(true);
    }
  });
}

/** Кнопки в настоящей области раздела: итог каскада всех тем, а не разбор CSS. */
async function paintedButtons(page: Page, host: string) {
  return page.evaluate((hostSel) => {
    // Внутри .scr, как настоящие кнопки экрана: правила старой темы (.rh2 .scr .pill…) тоже в силе.
    const parent = document.querySelector(`${hostSel} .scr`) ?? document.querySelector(hostSel);
    if (!parent) return null;
    const make = (cls: string, disabled = false) => {
      const b = document.createElement("button");
      b.className = cls; b.textContent = "x"; b.disabled = disabled; parent.appendChild(b);
      const s = getComputedStyle(b);
      const out = { bg: s.backgroundColor, color: s.color, opacity: s.opacity };
      b.remove();
      return out;
    };
    return { disabled: make("pill", true), disabledGhost: make("pill ghost", true), disabledDanger: make("pill rh-btn danger", true), danger: make("pill rh-btn danger") };
  }, host);
}

test("новый вид debt: выключенная кнопка приглушена, красная красная — клиенты, карточка, объекты, чаты", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "проверка цвета, одной ширины хватает");
  await withShell(page, { enabled: true, look: "royal" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const check = async (where: string, host: string) => {
    const r = await paintedButtons(page, host);
    expect(r, `${where}: область ${host} есть`).not.toBeNull();
    expect(r!.disabled.opacity, `${where}: выключенная главная`).toBe("0.5");
    expect(r!.disabledGhost.opacity, `${where}: выключенная серая`).toBe("0.5");
    expect(r!.disabledDanger.opacity, `${where}: выключенная красная`).toBe("0.5");
    // Красная остаётся красной (единственный смысловой вариант кнопки со своим цветом в старой
    // теме): сплошная красная заливка слоя или прежний красный контур с красным текстом.
    const reddish = (css: string) => { const [red, green, blue, alpha] = (css.match(/[\d.]+/g) ?? []).map(Number); return (alpha ?? 1) > 0 && red > green + 40 && red > blue + 40; };
    expect(reddish(r!.danger.bg) || reddish(r!.danger.color), `${where}: .pill.danger красная, а не фон ${r!.danger.bg} / текст ${r!.danger.color}`).toBe(true);
  };
  await page.goto("/clients");
  await expect(page.locator(".ry-crow").first()).toBeVisible({ timeout: 30_000 });
  await check("клиенты", '[data-ry-section="clients"] .scr');
  await openClientCard(page);
  // Ряд действий карточки — там самая тяжёлая перекраска раздела (вес 19 классов).
  if (await page.locator(".clean-client-header .acts").count()) await check("карточка, ряд действий", ".clean-client-header .acts");
  await page.goto("/properties");
  await expect(page.locator('[data-ry-section="objects"]').first()).toBeVisible({ timeout: 30_000 });
  await check("объекты", '[data-ry-section="objects"]');
  await page.goto("/messages");
  await expect(page.locator('[data-ry-section="chats"]').first()).toBeVisible({ timeout: 30_000 });
  await check("чаты", '[data-ry-section="chats"]');
});

test("новый вид debt: подписи групп настроек короткие, не склейка подразделов", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "одной ширины хватает");
  await withShell(page, { enabled: true, look: "royal" });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings");
    const subs = page.locator('.ry-set [aria-label="Группы настроек"] .ry-row-sub, .ry-set .ry-row-link .ry-row-sub');
    await expect(subs.first()).toBeVisible({ timeout: 30_000 });
    for (const text of await subs.allTextContents()) {
      expect(text.length, text).toBeLessThanOrEqual(40);
      expect(text, text).not.toContain(" · ");
    }
  }
});

test("новый вид debt: плашка «Уведомления заблокированы» переносится, а не обрезается", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины задаются явно");
  await withShell(page, { enabled: true, look: "royal" });
  await page.addInitScript(() => {
    try { Object.defineProperty(Notification, "permission", { get: () => "denied" }); } catch { /* нет Notification */ }
  });
  for (const width of [1024, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const txt = page.locator(".card.tight .quiet .txt", { hasText: "заблокированы браузером" });
    await expect(txt).toBeVisible({ timeout: 30_000 });
    const fit = await txt.evaluate((el) => {
      const s = getComputedStyle(el);
      return { clipped: el.scrollWidth > el.clientWidth + 1, ellipsis: s.textOverflow === "ellipsis", clamp: s.webkitLineClamp, nowrap: s.whiteSpace === "nowrap" };
    });
    expect(fit, `на ${width}px`).toEqual({ clipped: false, ellipsis: false, clamp: "none", nowrap: false });
    await expect(txt).toContainText("значок замка");
  }
});
