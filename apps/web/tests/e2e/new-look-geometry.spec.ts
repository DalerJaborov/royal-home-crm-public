import { test, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";
import { ANDROID_UA, IPHONE_UA, OWNER_WIDTHS, geometryFindings, type GeometryKind } from "./helpers/lookGeometry";
import { LOOK_CONVERSATION_ID, stubLookVisualData } from "./helpers/lookVisualFixtures";

/**
 * «НОВЫЙ ВИД» — СТОРОЖ ГЕОМЕТРИИ (20.11.2026, кадры владельца с iPhone).
 *
 * `new-look-*.spec.ts` ловят горизонтальный вылет и многоточие. Владелец на телефоне
 * нашёл поломки другого рода, и ни одна вылетом не была: пилюля «Ждут проверки» сжалась
 * в круг поверх «Найдено: 117», карточка «Этап просрочен» с пустым верхом, ряд вкладок
 * обрезан без признака прокрутки, «Позвонить» в реплике отдельной строкой, «10 нояб. —
 * / 19 нояб.» и «1,3 / млн с.» рвутся, в сетке плиток главной дыра. Механизмы описаны и
 * ловятся в helpers/lookGeometry.ts; здесь — где и на каких ширинах они обязаны молчать.
 *
 * Ширины — ряд владельца: 320, 360, 375, 390, 414, 430 (телефоны), 768, 820 (планшеты),
 * 1024, 1280, 1440, 1920 (ПК). Телефоны и планшеты — с отпечатком iPhone и Android и
 * касанием, обе темы. Данные, на которых видны баги, подменены (lookVisualFixtures.ts).
 */
type Screen = { url: string; ready: string; skip?: string; kinds?: readonly GeometryKind[] };

/** Экраны с кадров владельца — полный ряд ширин, обе темы, оба телефона. */
const OWNER_SCREENS: Screen[] = [
  { url: "/properties", ready: ".ry-objects-head" },
  { url: "/ads", ready: '[data-ry-section="marketing"] .tiles .tile' },
  { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: "[data-msg-call]" },
  { url: "/", ready: ".ry-today" },
  { url: "/clients", ready: '[data-ry-section="clients"]' },
];

type Device = { name: string; widths: readonly number[]; options: (width: number) => BrowserContextOptions };
const phone = (ua: string, theme: "light" | "dark") => (width: number): BrowserContextOptions =>
  ({ viewport: { width, height: 844 }, userAgent: ua, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme });
const desk = (theme: "light" | "dark") => (width: number): BrowserContextOptions => ({ viewport: { width, height: 900 }, colorScheme: theme });
const PHONE_WIDTHS = OWNER_WIDTHS.filter((w) => w < 1024);
const DESK_WIDTHS = OWNER_WIDTHS.filter((w) => w >= 1024);
const DEVICES: Device[] = [
  { name: "iPhone, светлая", widths: PHONE_WIDTHS, options: phone(IPHONE_UA, "light") },
  { name: "iPhone, тёмная", widths: PHONE_WIDTHS, options: phone(IPHONE_UA, "dark") },
  { name: "Android, светлая", widths: PHONE_WIDTHS, options: phone(ANDROID_UA, "light") },
  { name: "ПК, светлая", widths: DESK_WIDTHS, options: desk("light") },
  { name: "ПК, тёмная", widths: DESK_WIDTHS, options: desk("dark") },
];

async function open(page: Page, screen: Screen) {
  await page.goto(screen.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 20_000 });
  await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 20_000 });
}

async function sweep(browser: Browser, role: RoleName, device: Device, screens: Screen[]) {
  const problems: string[] = [];
  // Контекст на каждую ширину: отпечаток касания и масштаб задаются только при создании.
  for (const width of device.widths) {
    const context = await contextForRole(browser, role, device.options(width));
    const page = await context.newPage();
    await stubLookVisualData(page);
    for (const screen of screens) {
      await open(page, screen);
      await page.waitForTimeout(300);
      for (const f of await geometryFindings(page, { skip: screen.skip, kinds: screen.kinds })) problems.push(`${screen.url} @${width}: ${f}`);
    }
    await context.close();
  }
  return problems;
}

for (const device of DEVICES) {
  test(`новый вид, геометрия экранов с кадров владельца — ${device.name} @smoke`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "контексты и ширины задаются внутри теста");
    test.setTimeout(15 * 60_000);
    expect(await sweep(browser, "DIRECTOR", device, OWNER_SCREENS), "поломки геометрии").toEqual([]);
  });
}

/** «Реклама», телефон: выбор периода и выбор раздела — одной ширины и одного вида (кадр владельца 20.11). */
test("новый вид, «Реклама»: выпадашки одной ширины и вида на телефоне @smoke", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  for (const width of [320, 390, 430]) {
    const context = await contextForRole(browser, "DIRECTOR", phone(IPHONE_UA, "light")(width));
    const page = await context.newPage();
    await stubLookVisualData(page);
    await open(page, { url: "/ads", ready: '[data-ry-section="marketing"] .tiles .tile' });
    const selects = await page.locator('[data-ry-section="marketing"] select').evaluateAll((els) => els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => { const s = getComputedStyle(el); return { w: Math.round(el.getBoundingClientRect().width), weight: s.fontWeight, size: s.fontSize, h: Math.round(el.getBoundingClientRect().height) }; }));
    expect(selects.length, `выпадашки на ${width}px`).toBeGreaterThanOrEqual(2);
    expect(new Set(selects.map((s) => JSON.stringify(s))).size, `разный вид выпадашек на ${width}px: ${JSON.stringify(selects)}`).toBe(1);
    await context.close();
  }
});

/**
 * СТОРОЖ ПРОВЕРЕН ПОЛОМКОЙ. Зелёный прогон одинаково выглядит и когда всё хорошо, и когда
 * сломана сама проверка (CLAUDE.md, 29.09). Поэтому каждая поломка с кадров владельца
 * вносится в страницу нарочно — и каждый вид проверки обязан её назвать.
 */
test("новый вид, сторож геометрии ловит каждую поломку с кадров владельца @smoke", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  test.setTimeout(5 * 60_000);
  const context = await contextForRole(browser, "DIRECTOR", phone(IPHONE_UA, "light")(414));
  const page = await context.newPage();
  await stubLookVisualData(page);
  const R = ':root[data-ui-look="royal"]';
  const breaks: { url: string; ready: string; css: string; kind: GeometryKind }[] = [
    // пилюля «Ждут вашей проверки» сжата в круг, «Найдено: 117» рвётся
    { url: "/properties", ready: ".ry-objects-pending", kind: "squeeze", css: `${R} .ry-objects-pending { flex: 0 1 28px !important; width: 28px !important; overflow: hidden !important; }` },
    { url: "/properties", ready: ".ry-objects-found .ry-num", kind: "split", css: `${R} .ry-objects-found { display: inline-block !important; width: 40px !important; white-space: normal !important; }` },
    // пустой верх у «Этап просрочен»
    { url: "/properties", ready: ".clean-catalog-overdue", kind: "lopsided", css: `${R} .clean-catalog-overdue .quiet { margin-top: 40px !important; }` },
    // ряд вкладок обрезан без затухания
    { url: "/properties", ready: ".seg-ai", kind: "stripHint", css: `${R} .seg-ai { animation: none !important; -webkit-mask-image: none !important; mask-image: none !important; }` },
    // размытый заголовок шапки
    { url: "/properties", ready: "[data-topbar-title]", kind: "blur", css: `${R} [data-topbar-title] { opacity: .6 !important; }` },
    // низ страницы под нижним меню
    { url: "/properties", ready: ".ry-objects-head", kind: "underNav", css: `${R} .clean-shell .app-main-col { padding-bottom: 0 !important; }` },
    // «Позвонить» отдельным блоком
    { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: "[data-msg-call]", kind: "ghostCall", css: `${R} [data-msg-call] { display: flex !important; }` },
    // подписи нижнего меню вплотную
    { url: "/properties", ready: "nav[data-bottomnav]", kind: "navCrowd", css: `${R}[data-mobile-ux] nav[data-bottomnav] [data-tab-label] { letter-spacing: 4px !important; }` },
    // «Продавц/ы» — слово во вкладке разорвано по буквам
    { url: "/clients", ready: '[data-ry-section="clients"] .seg', kind: "wordBreak", css: `${R} [data-ry-section="clients"] .seg button { width: 56px !important; flex: none !important; overflow-wrap: anywhere !important; }` },
    // дыра в сетке плиток главной
    { url: "/", ready: ".ry-strip", kind: "hole", css: `${R} [data-ry-section="home"] .ry-strip > .ry-tile:last-child { grid-column: 1 / -1 !important; }` },
  ];
  for (const b of breaks) {
    await open(page, { url: b.url, ready: b.ready });
    expect(await geometryFindings(page, { kinds: [b.kind] }), `${b.kind} без поломки на ${b.url}`).toEqual([]);
    await page.addStyleTag({ content: b.css });
    await page.waitForTimeout(200);
    expect((await geometryFindings(page, { kinds: [b.kind] })).length, `${b.kind}: нарочная поломка не поймана (${b.css})`).toBeGreaterThan(0);
  }
  await context.close();
});

/**
 * Все экраны нового вида для директора и РОП на трёх ширинах — класс целиком, не только кадры
 * владельца. Дольше, поэтому без @smoke: гоняется полным e2e.
 */
// Агенту «Новый вид» не выдаётся: у роли нет чистой оболочки (hooks/useCleanShell.ts,
// cleanShellAllowedOnDevice) — экраны агента живут в прежнем виде и здесь не проверяются.
const ALL_SCREENS: Record<"DIRECTOR" | "MANAGER", string[]> = {
  DIRECTOR: ["/", "/clients", "/sellers", "/properties", "/deals", "/calendar", "/messages", "/calls", "/ads", "/marketing", "/social-videos",
    "/finance", "/reports", "/team", "/oversight", "/mission-control", "/settings", "/profile", "/notifications", "/archive", "/vacancies",
    "/security", "/activity", "/pult", "/funnel", "/sources", "/insights", "/health", "/comments", "/site-changes", "/market", "/more",
    "/hall-of-fame", "/lead-funnel", "/hot-clients", "/lost-clients", "/inactive-clients", "/deferred-clients", "/other-inquiries",
    "/clients/all-mine", "/telephony", "/integrations", "/backups", "/stuck-work", "/ai-learning", "/bot-training", "/pipeline", "/settings/roles"],
  MANAGER: ["/", "/clients", "/sellers", "/properties", "/deals", "/calendar", "/messages", "/calls", "/team", "/oversight", "/notifications", "/profile", "/more"],
};
for (const role of Object.keys(ALL_SCREENS) as (keyof typeof ALL_SCREENS)[]) {
  for (const device of [DEVICES[0], DEVICES[3]]) {
    test(`новый вид, геометрия всех экранов — ${role}, ${device.name}`, async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "контексты и ширины задаются внутри теста");
      test.setTimeout(30 * 60_000);
      const screens = ALL_SCREENS[role].map((url) => ({ url, ready: "main#main" }));
      const narrowed = { ...device, widths: device.widths.filter((w) => [320, 390, 1440].includes(w)) };
      expect(await sweep(browser, role, narrowed, screens), "поломки геометрии").toEqual([]);
    });
  }
}
