import { test, expect, webkit, devices, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";
import { ANDROID_UA, CONSTITUTION_KINDS, GEOMETRY_KINDS, IPHONE_UA, OWNER_WIDTHS, geometryFindings, type GeometryKind } from "./helpers/lookGeometry";
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
 *
 * Два уровня (ревью #328): @smoke — 320/390/1440, светлая тема, быстро; полная матрица
 * ширин, тем, Android и движок WebKit (Safari) — тег @geometry-full, полным прогоном e2e.
 */
type Screen = { url: string; ready: string; skip?: string; kinds?: readonly GeometryKind[] };

/** Экраны с кадров владельца — полный ряд ширин, обе темы, оба телефона. */
const OWNER_SCREENS: Screen[] = [
  { url: "/properties", ready: ".ry-objects-head" },
  // «Реклама» — раздел директора: 20.11 его переделывает параллельная ветка (feat/look-director-sections),
  // её ссылки-подписи и строки отчёта ниже 44 px. Конституция (цель 44, текст 13, список) — после её влития.
  { url: "/ads", ready: '[data-ry-section="marketing"] .tiles .tile', kinds: GEOMETRY_KINDS.filter((k) => !CONSTITUTION_KINDS.includes(k)) },
  // Чат ждёт пузыри, а не кнопку: в новом виде номер в реплике — тихое «номер скрыт»
  // (решение владельца «как WhatsApp», ветка look-chat-clean), кнопки может не быть.
  // Окно переписки целиком у ветки look-chat-clean (#332): здесь только «Позвонить»
  // в реплике и размытость заголовков; раскладку пузырей сторожит та ветка.
  { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: ".bub", kinds: ["ghostCall", "blur"] },
  { url: "/", ready: ".ry-today" },
  { url: "/clients", ready: '[data-ry-section="clients"]' },
  // Настройки: квадрат-рамка внутри капсулы поиска (ревью #337) — двойная рамка поля и мелкий текст.
  { url: "/settings", ready: ".ry-search", kinds: ["fieldFrame", "smallText", "selectClip"] },
  // Дашборд директора (21.11.2026): ответы подменены (stubDirectorDashboard в lookVisualFixtures) — длинное имя менеджера, нули, деньги.
  { url: "/director", ready: ".dd-head" },
];

type Device = { name: string; widths: readonly number[]; options: (width: number) => BrowserContextOptions };
const phone = (ua: string, theme: "light" | "dark") => (width: number): BrowserContextOptions =>
  ({ viewport: { width, height: 844 }, userAgent: ua, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme });
const desk = (theme: "light" | "dark") => (width: number): BrowserContextOptions => ({ viewport: { width, height: 900 }, colorScheme: theme });
const PHONE_WIDTHS = OWNER_WIDTHS.filter((w) => w < 1024);
const DESK_WIDTHS = OWNER_WIDTHS.filter((w) => w >= 1024);
/** Быстрый сторож: 320, 390 и 1440 в светлой теме. */
const SMOKE_DEVICES: Device[] = [
  { name: "iPhone 320/390, светлая", widths: [320, 390], options: phone(IPHONE_UA, "light") },
  { name: "ПК 1440, светлая", widths: [1440], options: desk("light") },
];
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

/**
 * Планшет 768/820: раскладка (плитки, колонки) ждёт решения дизайн-критика — дыры в сетке
 * плиток там пока не считаются поломкой. Остальные механизмы проверяются и там.
 */
const TABLET_PENDING: readonly GeometryKind[] = ["hole"];
const kindsAt = (width: number, kinds?: readonly GeometryKind[]) =>
  (kinds ?? GEOMETRY_KINDS).filter((k) => !(width >= 768 && width < 1024 && TABLET_PENDING.includes(k)));

async function sweep(browser: Browser, role: RoleName, device: Device, screens: Screen[]) {
  const problems: string[] = [];
  // Контекст на каждую ширину: отпечаток касания и масштаб задаются только при создании.
  for (const width of device.widths) {
    const context = await contextForRole(browser, role, device.options(width));
    const page = await context.newPage();
    await stubLookVisualData(page);
    for (const screen of screens) {
      await open(page, screen);
      // Замер — после загрузки шрифтов: до неё строки другой ширины и переносы врут.
      await page.evaluate(() => document.fonts.ready.then(() => true));
      for (const f of await geometryFindings(page, { skip: screen.skip, kinds: kindsAt(width, screen.kinds) })) problems.push(`${screen.url} @${width}: ${f}`);
    }
    await context.close();
  }
  return problems;
}

for (const device of SMOKE_DEVICES) {
  test(`новый вид, геометрия экранов с кадров владельца — ${device.name} @smoke`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "контексты и ширины задаются внутри теста");
    test.setTimeout(10 * 60_000);
    expect(await sweep(browser, "DIRECTOR", device, OWNER_SCREENS), "поломки геометрии").toEqual([]);
  });
}
for (const device of DEVICES) {
  test(`новый вид, геометрия экранов с кадров владельца — полный ряд, ${device.name} @geometry-full`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "контексты и ширины задаются внутри теста");
    test.setTimeout(15 * 60_000);
    expect(await sweep(browser, "DIRECTOR", device, OWNER_SCREENS), "поломки геометрии").toEqual([]);
  });
}

/**
 * «Размер текста: очень крупный» (+25%, Профиль → Оформление) на самом узком телефоне: ничего не
 * вылезает и не режется — длинное переносится строкой (решение владельца 20.11, пачка C).
 */
test("новый вид, геометрия при «Очень крупном» тексте — iPhone 320 и 390 @smoke", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
  test.setTimeout(15 * 60_000);
  const problems: string[] = [];
  for (const width of [320, 390]) {
    const context = await contextForRole(browser, "DIRECTOR", phone(IPHONE_UA, "light")(width));
    const page = await context.newPage();
    await stubLookVisualData(page, { textSize: "xlarge" });
    for (const screen of OWNER_SCREENS.filter((s) => s.url !== "/ads")) {
      await open(page, screen);
      await expect(page.locator("html")).toHaveAttribute("data-text-size", "xlarge");
      await page.evaluate(() => document.fonts.ready.then(() => true));
      for (const f of await geometryFindings(page, { skip: screen.skip, kinds: kindsAt(width, screen.kinds) })) problems.push(`${screen.url} @${width} xlarge: ${f}`);
    }
    await context.close();
  }
  expect(problems, "поломки геометрии при очень крупном тексте").toEqual([]);
});

/**
 * «Крупный» и «Очень крупный» на всех телефонах владельца (360–430), обе темы, директор и агент,
 * пять главных экранов — полным прогоном (пачка C, повторное ревью #337).
 */
const TEXT_SCREENS: Screen[] = [
  { url: "/", ready: ".ry-today" },
  { url: "/clients", ready: '[data-ry-section="clients"]' },
  { url: "/properties", ready: ".ry-objects-head" },
  { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: ".bub", kinds: ["ghostCall", "blur", "smallText", "fieldFrame"] },
  // «Деньги» — раздел директора параллельной ветки: пустая область «note» у карточки трат есть и при
  // обычном тексте (данных для строки нет) — её проверит та ветка.
  { url: "/finance", ready: "main#main", kinds: GEOMETRY_KINDS.filter((k) => k !== "emptyArea") },
];
for (const textSize of ["large", "xlarge"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`новый вид, «${textSize === "large" ? "Крупный" : "Очень крупный"}» текст, телефоны 360–430, ${theme} @geometry-full`, async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "контекст задаётся внутри теста");
      test.setTimeout(30 * 60_000);
      const problems: string[] = [];
      for (const role of ["DIRECTOR", "AGENT"] as const) {
        for (const width of [360, 390, 414, 430]) {
          const context = await contextForRole(browser, role, phone(IPHONE_UA, theme)(width));
          const page = await context.newPage();
          await stubLookVisualData(page, { textSize });
          // Первый заход холодной сессии дольше (вход по cookie, настройки, /ui-shell) — прогрев.
          await page.goto("/clients", { waitUntil: "domcontentloaded" });
          await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 60_000 }).catch(() => {});
          // Главная агента на телефоне — по настройке сервера (#329), подмена /ui-shell новый вид не включает.
          for (const screen of TEXT_SCREENS.filter((sc) => !(role === "AGENT" && sc.url === "/"))) {
            await open(page, screen);
            await page.evaluate(() => document.fonts.ready.then(() => true));
            for (const f of await geometryFindings(page, { skip: screen.skip, kinds: kindsAt(width, screen.kinds) })) problems.push(`${role} ${screen.url} @${width} ${textSize}: ${f}`);
          }
          await context.close();
        }
      }
      expect(problems, "поломки геометрии при крупном тексте").toEqual([]);
    });
  }
}

/**
 * Движок Safari (WebKit): iPhone 390 и ПК 1440. Владелец смотрит с iPhone, а Chromium и
 * WebKit по-разному переносят строки и рисуют шрифт. WebKit ставится отдельно
 * (`npx playwright install webkit`); не установлен — тест пропускается с причиной.
 */
test("новый вид, геометрия экранов с кадров владельца — WebKit (Safari) @geometry-full", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "движок запускается внутри теста");
  test.setTimeout(10 * 60_000);
  const safari = await webkit.launch().catch(() => null);
  test.skip(!safari, "WebKit не установлен: npx playwright install webkit");
  try {
    const iphone: Device = { name: "WebKit iPhone 390", widths: [390], options: () => ({ ...devices["iPhone 13"], colorScheme: "light" }) };
    const pc: Device = { name: "WebKit ПК 1440", widths: [1440], options: desk("light") };
    const problems = [...await sweep(safari!, "DIRECTOR", iphone, OWNER_SCREENS), ...await sweep(safari!, "DIRECTOR", pc, OWNER_SCREENS)];
    expect(problems, "поломки геометрии в WebKit").toEqual([]);
  } finally {
    await safari?.close();
  }
});

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
  const breaks: { url: string; ready: string; css: string; kind: GeometryKind; optional?: boolean }[] = [
    // пилюля наезжает на «Найдено: 117» — буквы на буквах
    { url: "/properties", ready: ".ry-objects-pending", kind: "overlap", css: `${R} .ry-objects-pending { margin-left: -140px !important; }` },
    // пилюля «Ждут вашей проверки» сжата в круг, «Найдено: 117» рвётся
    { url: "/properties", ready: ".ry-objects-pending", kind: "squeeze", css: `${R} .ry-objects-pending { flex: 0 1 28px !important; width: 28px !important; overflow: hidden !important; }` },
    { url: "/properties", ready: ".ry-objects-found .ry-num", kind: "split", css: `${R} .ry-objects-found { display: inline-block !important; width: 40px !important; white-space: normal !important; }` },
    // пустой верх у тихой строки в карточке («Этап просрочен» из каталога нового вида
    // убран #331 — тот же механизм на «Не связывались» клиентов)
    { url: "/clients", ready: ".clean-client-notices > .quiet", kind: "lopsided", css: `${R} .clean-client-notices > .quiet { margin-top: 40px !important; }` },
    // ряд вкладок обрезан без затухания
    // (вкладки каталога #331 убрал в шторку фильтров — тот же механизм у вкладок «Денег»)
    // (с #336 вкладки «Денег» переносятся строкой и за край не уходят — ряд обрезается нарочно)
    { url: "/finance", ready: ".cef-main-tabs", kind: "stripHint", css: `${R} .cef-main-tabs { flex-wrap: nowrap !important; overflow-x: auto !important; max-width: 220px !important; animation: none !important; -webkit-mask-image: none !important; mask-image: none !important; } ${R} .cef-main-tabs > * { flex: none !important; }` },
    // размытый заголовок шапки
    { url: "/properties", ready: "[data-topbar-title]", kind: "blur", css: `${R} [data-topbar-title] { opacity: .6 !important; }` },
    // низ страницы под нижним меню
    { url: "/properties", ready: ".ry-objects-head", kind: "underNav", css: `${R} .clean-shell .app-main-col { padding-bottom: 0 !important; }` },
    // «Позвонить» отдельным блоком
    // (только если кнопка в реплике есть: в новом виде номер может быть тихим текстом)
    { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: ".bub", kind: "ghostCall", optional: true, css: `${R} [data-msg-call] { display: flex !important; }` },
    // подписи нижнего меню вплотную
    { url: "/properties", ready: "nav[data-bottomnav]", kind: "navCrowd", css: `${R}[data-mobile-ux] nav[data-bottomnav] [data-tab-label] { letter-spacing: 4px !important; }` },
    // «Продавц/ы» — слово во вкладке разорвано по буквам
    { url: "/clients", ready: '[data-ry-section="clients"] .seg', kind: "wordBreak", css: `${R} [data-ry-section="clients"] .seg button { width: 56px !important; flex: none !important; overflow-wrap: anywhere !important; }` },
    // именованная область строки клиента осталась пустой (строка «when» без даты)
    { url: "/clients", ready: ".ry-crow .ry-crow-when", kind: "emptyArea", css: `${R} [data-ry-section="clients"] .ry-crow .ry-crow-when { grid-area: req !important; }` },
    // дыра в сетке плиток главной
    { url: "/", ready: ".ry-strip", kind: "hole", css: `${R} [data-ry-section="home"] .ry-strip > .ry-tile:last-child { grid-column: 1 / -1 !important; }` },
    // Конституция оболочки (пачка C): текст мельче 13, цель нажатия меньше 44, обрезанный список.
    { url: "/clients", ready: ".ry-crow .ry-crow-name", kind: "smallText", css: `${R} [data-ry-section="clients"] .ry-crow-name { font-size: 11px !important; }` },
    { url: "/", ready: ".ry-section-link", kind: "smallTap", css: `${R} .ry-section-link { min-width: 0 !important; min-height: 20px !important; padding: 0 !important; }` },
    { url: "/settings", ready: ".ry-search input", kind: "fieldFrame", css: `${R} .ry-search input { box-shadow: inset 0 0 0 1px var(--rh-ui-field-line) !important; }` },
    { url: "/", ready: ".ry-today", kind: "selectClip", optional: true, css: `${R} .clean-shell .clean .clean-decision-select { field-sizing: fixed !important; width: 72px !important; flex: none !important; }` },
  ];
  for (const b of breaks) {
    await open(page, { url: b.url, ready: b.ready });
    if (b.optional && b.kind === "ghostCall" && (await page.locator("[data-msg-call]").count()) === 0) continue;
    if (b.optional && b.kind === "selectClip" && (await page.locator(".clean-decision-select").count()) === 0) continue;
    await page.evaluate(() => document.fonts.ready.then(() => true));
    expect(await geometryFindings(page, { kinds: [b.kind] }), `${b.kind} без поломки на ${b.url}`).toEqual([]);
    await page.addStyleTag({ content: b.css });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect((await geometryFindings(page, { kinds: [b.kind] })).length, `${b.kind}: нарочная поломка не поймана (${b.css})`).toBeGreaterThan(0);
  }
  await context.close();
});

/**
 * Все экраны нового вида для директора, РОП и агента на трёх ширинах — класс целиком, не только кадры
 * владельца. Дольше, поэтому без @smoke: гоняется полным e2e.
 */
const ALL_SCREENS: Record<"DIRECTOR" | "MANAGER" | "AGENT", string[]> = {
  DIRECTOR: ["/", "/clients", "/sellers", "/properties", "/deals", "/calendar", "/messages", "/calls", "/ads", "/marketing", "/social-videos",
    "/finance", "/reports", "/director", "/team", "/oversight", "/mission-control", "/settings", "/profile", "/notifications", "/archive", "/vacancies",
    "/security", "/activity", "/pult", "/funnel", "/sources", "/insights", "/health", "/comments", "/site-changes", "/market", "/more",
    "/hall-of-fame", "/lead-funnel", "/hot-clients", "/lost-clients", "/inactive-clients", "/deferred-clients", "/other-inquiries",
    "/clients/all-mine", "/telephony", "/integrations", "/backups", "/stuck-work", "/ai-learning", "/bot-training", "/pipeline", "/settings/roles"],
  MANAGER: ["/", "/clients", "/sellers", "/properties", "/deals", "/calendar", "/messages", "/calls", "/team", "/oversight", "/notifications", "/profile", "/more"],
  // Агенту «Новый вид» на телефоне выдаётся с #329 (hooks/shellDevicePolicy.ts).
  AGENT: ["/", "/clients", "/sellers", "/properties", "/deals", "/calendar", "/messages", "/calls", "/notifications", "/profile", "/more"],
};
for (const role of Object.keys(ALL_SCREENS) as (keyof typeof ALL_SCREENS)[]) {
  // Агенту на телефоне новый вид решает сервер по своей настройке (#329), подмена /ui-shell
  // его не включает — агент проверяется на ПК.
  for (const device of role === "AGENT" ? [DEVICES[3]] : [DEVICES[0], DEVICES[3]]) {
    test(`новый вид, геометрия всех экранов — ${role}, ${device.name} @geometry-full`, async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium", "контексты и ширины задаются внутри теста");
      test.setTimeout(30 * 60_000);
      // Конституция (цель 44, текст 13, список) на всех экранах — пока без них: обязательна на
      // экранах с кадров владельца (@smoke выше); по остальным — после прохода по разделам (пачка C, 20.11).
      // Двойная рамка поля (fieldFrame) уже проверяется везде: 48 экранов пройдены (повторное ревью #337).
      const screens = ALL_SCREENS[role].map((url) => ({ url, ready: "main#main", kinds: GEOMETRY_KINDS.filter((k) => k === "fieldFrame" || !CONSTITUTION_KINDS.includes(k)) }));
      const narrowed = { ...device, widths: device.widths.filter((w) => [320, 390, 1440].includes(w)) };
      expect(await sweep(browser, role, narrowed, screens), "поломки геометрии").toEqual([]);
    });
  }
}
