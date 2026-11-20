import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД»: правки карточек объекта и клиента по кадрам владельца с iPhone (20.11.2026).
 * Ответ /ui-shell подменяется (как в соседних new-look-*.spec.ts); картинки объекта — рисованные, чтобы проверить
 * горизонтальное и вертикальное фото в одной рамке; сводку клиента и предложение «Взять из разговора» отдаёт подмена
 * (сам разбор сводки и права проверяют тесты API). Кадры снимаются, если задана SHOTS_DIR (метка — SHOTS_TAG).
 */
const SHOTS = process.env.SHOTS_DIR;
const TAG = process.env.SHOTS_TAG ?? "after";

async function withShell(page: Page) {
  await page.route("**/api/v1/ui-shell", (r) => r.request().method() === "GET"
    ? r.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } }) : r.fallback());
}
/** Все картинки объекта — рисованные: первая горизонтальная 16:9, вторая вертикальная 9:16, остальные квадратные. */
async function fakePhotos(page: Page) {
  let n = 0;
  const seen = new Map<string, [number, number, string]>();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "image") return route.fallback();
    const key = route.request().url();
    if (!seen.has(key)) { const i = n++; seen.set(key, i === 0 ? [1600, 900, "#3b82f6"] : i === 1 ? [900, 1600, "#16a34a"] : [1000, 1000, "#f59e0b"]); }
    const [w, h, color] = seen.get(key)!;
    await route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" font-size="${Math.round(h / 8)}" fill="#fff" text-anchor="middle">${w}x${h}</text></svg>` });
  });
}
async function openFirstObject(page: Page) {
  await page.goto("/properties");
  await page.locator(".ry-obj-card .ry-obj-link").first().click();
  await expect(page.locator(".ry-obj-summary")).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${TAG}-${name}.png`, fullPage: true });
}

for (const [label, width, height] of [["m390", 390, 844], ["d1440", 1440, 900]] as const) {
  test(`карточка объекта ${label}: фото целиком на размытой подложке, плашка спокойная, район один раз @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
    test.setTimeout(120_000);
    await withShell(page); await fakePhotos(page);
    await page.setViewportSize({ width, height });
    // Плашка этапа в списке и в карточке — один тон и один текст (одна функция).
    await page.goto("/properties");
    const listPill = page.locator(".ry-obj-card").first().locator(".ry-obj-pill, .ry-obj-state").locator("visible=true").first();
    await expect(listPill).toBeVisible();
    const listTone = await listPill.getAttribute("data-tone");
    const listText = (await listPill.innerText()).trim();
    await page.locator(".ry-obj-card .ry-obj-link").first().click();
    await expect(page.locator(".ry-obj-summary")).toBeVisible();
    await page.waitForTimeout(1200);

    // 1. Фото целиком (contain) поверх размытой подложки того же снимка.
    const slide = page.locator(".rh-gallery-slide").first();
    await expect(slide.locator("img[data-photo-backdrop]")).toHaveCount(1);
    expect(await slide.locator("img:not([data-photo-backdrop])").evaluate((el) => getComputedStyle(el).objectFit)).toBe("contain");
    expect(await slide.locator("img[data-photo-backdrop]").evaluate((el) => getComputedStyle(el).filter)).toContain("blur");
    // Подложка берёт лёгкую миниатюру, а не полноразмерный снимок.
    const [backdropSrc, mainSrc] = await Promise.all([slide.locator("img[data-photo-backdrop]").getAttribute("src"), slide.locator("img:not([data-photo-backdrop])").getAttribute("src")]);
    expect(backdropSrc).not.toBe(mainSrc);
    // 3. Плашка этапа: без «, N дн.» через запятую.
    const pill = page.getByTestId("property-stage");
    await expect(pill).toBeVisible();
    expect((await pill.innerText()).trim()).not.toMatch(/,\s*\d+\s*дн\.$/);
    expect(await pill.getAttribute("data-tone")).toBe(listTone);
    expect((await pill.innerText()).trim()).toBe(listText);
    // 2. Район — не больше одного раза в главном блоке (заголовок или строка адреса), без повторов под ценой.
    const summary = page.locator(".ry-obj-summary");
    const district = (await page.evaluate(async () => {
      const id = location.pathname.split("/").pop();
      const res = await fetch(`/api/v1/properties/${id}`, { credentials: "include" }).catch(() => null);
      return res && res.ok ? (await res.json()).district?.name ?? "" : "";
    })) as string;
    const text = await summary.innerText();
    if (district) expect(text.split(district).length - 1).toBeLessThanOrEqual(1);
    await expectNoOverflowAt(page, width, ".ry-obj-summary, .rh-gallery, .ry-gal-thumbs", { strips: ".ry-gal-thumbs, .rh-gallery-track" });
    await shot(page, `object-${label}`);
  });

  test(`карточка клиента ${label}: «Заявка», спокойная оценка, «Взять из разговора» записывает по нажатию @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
    test.setTimeout(120_000);
    await withShell(page);
    const written: unknown[] = [];
    await page.route(/\/api\/v1\/clients\/(\d+|[0-9a-f-]{36})(\?.*)?$/i, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      Object.assign(body, { kind: "BUYER", dualIntent: false, acceptedAt: body.acceptedAt ?? new Date().toISOString(), pendingAcceptance: false, aiScore: 30,
        aiInsight: "Ищет: дом/участок, 3-4 сотки, район Назди Сомон\nВедёт: Умед", aiInsightAt: new Date().toISOString(),
        desiredType: null, desiredRooms: null, budgetMin: null, budgetMax: null, desiredDistrictId: null, desiredDistrict: null, requirementsFieldsKind: "BUYER" });
      await route.fulfill({ response: res, json: body });
    });
    // GET отдаёт только подписи; запись — POST …/apply без тела (сервер сам считает предложение по текущей карточке).
    await page.route(/\/requirements-suggestion$/, (r) => r.fulfill({ json: { available: true, fingerprint: "abc123abc123abc1", labels: ["дом", "Назди Сомон"] } }));
    await page.route(/\/requirements-suggestion\/apply$/, async (r) => { written.push(r.request().postDataJSON()); await r.fulfill({ json: {} }); });
    await page.setViewportSize({ width, height });
    await page.goto("/clients");
    await page.locator("a[href^='/clients/']").first().click();
    await page.waitForTimeout(2500);

    await expect(page.getByText("Всё о клиенте")).toBeVisible();
    // Оценка ИИ — спокойным чипом с подписью, не красным.
    const chip = page.locator(".sec-h .chip", { hasText: "Шанс сделки" });
    await expect(chip).toHaveText("Шанс сделки: низкий · 30/100");
    await expect(chip).not.toHaveClass(/crit/);
    // Слово «лид» сотруднику не показываем.
    expect(await page.locator("main").innerText()).not.toMatch(/(^|[^а-яё])[Лл]ид(?![а-яё])/u);
    // Автоматически ничего не записано; кнопка есть; по нажатию — обычная запись пожеланий.
    expect(written).toHaveLength(0);
    const take = page.getByTestId("take-from-conversation").getByRole("button", { name: "Взять из разговора: дом, Назди Сомон" });
    await expect(take).toBeVisible();
    await shot(page, `client-${label}`);
    await take.click();
    await expect.poll(() => written.length).toBe(1);
    expect(written[0]).toEqual({ fingerprint: "abc123abc123abc1" });
  });
}

test("карточки: последний блок не прячется под нижним меню на 390 @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины выставляются в десктопном проекте");
  test.setTimeout(120_000);
  await withShell(page); await fakePhotos(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const check = async (what: string) => {
    await page.waitForTimeout(800);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator(".app-main-col").evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await page.waitForTimeout(400);
    const gap = await page.evaluate(() => {
      const nav = document.querySelector("nav[data-bottomnav]") as HTMLElement | null;
      if (!nav) return null;
      const navTop = nav.getBoundingClientRect().top;
      let low = 0;
      document.querySelectorAll("main *").forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.height > 0 && r.width > 0 && r.top < navTop + 200) low = Math.max(low, r.bottom);
      });
      return navTop - low;
    });
    expect(gap, `${what}: нижнее меню найдено`).not.toBeNull();
    expect(gap!, `${what}: между последним блоком и меню должен быть зазор`).toBeGreaterThanOrEqual(0);
  };
  await openFirstObject(page); await check("карточка объекта");
  await page.goto("/clients");
  await page.locator("a[href^='/clients/']").first().click();
  await page.waitForTimeout(1500); await check("карточка клиента");
  // Липкая панель «Отправить выбранные» (если она липкая) стоит над меню: её нижний край не ниже верха меню.
  const toolbar = page.locator(".client-match-toolbar").first();
  if (await toolbar.count()) {
    const clear = await page.evaluate(() => {
      const nav = document.querySelector("nav[data-bottomnav]") as HTMLElement;
      const bar = document.querySelector(".client-match-toolbar") as HTMLElement;
      const style = getComputedStyle(bar);
      return { sticky: style.position === "sticky", bottom: parseFloat(style.bottom), need: window.innerHeight - nav.getBoundingClientRect().top };
    });
    if (clear.sticky) expect(clear.bottom, "панель выше нижнего меню").toBeGreaterThanOrEqual(clear.need);
  }
});
