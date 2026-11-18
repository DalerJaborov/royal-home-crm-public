import { test, expect, type Page } from "@playwright/test";
import { LOOK_WIDTHS, expectNoOverflowAt } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — «Звонки», «Телефония», окно звонка и «Календарь» (пачки calls и
 * calendar, 18.11.2026): сторож вёрстки.
 *
 * Ответы API подменяются, чтобы проверять сам экран, а не содержимое базы стенда
 * (в сиде звонков почти нет, SIP на стенде не настроен): на девяти ширинах журнал,
 * телефония, окно звонка и календарь не дают горизонтальной прокрутки и ничего не
 * вылезает за край карточки. Без признака с сервера разметки нового вида нет.
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const LONG = "Очень длинное имя клиента для проверки переноса строки в журнале звонков";
const analysis = { score: 41, greeted: true, foundNeed: true, presentedValue: false, handledObjection: false, agreedNextStep: false,
  objections: ["Дорого"], agreements: [], summary: `Спросил про Сино ${"и бюджет ".repeat(6)}`, summaryTj: null, coaching: null };
const calls = [
  { id: "c1", createdAt: ago(5), notes: null, hasRecording: true, canHear: true, durationSec: 245, callAttempt: "TALKED", transcript: "Агент: Алло.\nКлиент: Здравствуйте.", transcriptRu: null,
    transcriptionStage: null, transcriptionProgress: null, agent: { id: "a1", fullName: "Сотрудник Один", avatarUrl: null }, client: { id: "k1", shortId: 1, fullName: LONG }, analysis },
  { id: "c2", createdAt: ago(30), notes: null, hasRecording: false, canHear: true, durationSec: 0, callAttempt: "NO_ANSWER", transcript: null, transcriptRu: null,
    transcriptionStage: null, transcriptionProgress: null, agent: { id: "a2", fullName: "Сотрудник Два", avatarUrl: null }, client: { id: "k2", shortId: 2, fullName: "Клиент Два" }, analysis: null },
];
const incoming = [
  { id: "i1", phone: "+992900000007", startedAt: ago(10), endedAt: ago(9), answered: false, talkSeconds: 0, answeredBy: null, answeredByName: null, client: null,
    callbackAgent: null, qualifiedAt: null, qualifiedBy: null, irrelevant: false, autoCreatedClient: false, missingCallback: true, missedCallbackHours: 2 },
];
const dashboard = {
  station: { configured: true, online: true, registered: 1, total: 2 },
  extensions: [{ agentId: "a1", fullName: LONG, extension: "101", online: true, knownToStation: true }, { agentId: "a2", fullName: "Сотрудник Два", extension: "102", online: false, knownToStation: false }],
  live: { incoming: [{ channelId: "L1", phone: "+992900000008", clientName: LONG, clientShortId: 1, answered: false, answeredBy: null, answeredByName: null, seconds: 18 }],
    outgoing: [{ channelId: "L2", clientName: "Клиент Два", clientShortId: 2, state: "ringing_client", seconds: 9 }] },
  today: { incoming: 12, outgoing: 27, missed: 3, unqualified: 2 },
  settings: { operators: 2, pushEnabled: true, panelEnabled: true, autoCreateClient: true, hoursEnabled: false, hoursStart: "09:00", hoursEnd: "18:00", forwardPhone: null, primaryTarget: "queue", primaryExtension: null },
};
const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const tasks = [
  { id: "t1", clientId: "k1", type: "SHOWING", nextActionDate: at(15), nextAction: "Показ", taskCancelledAt: null, confirmAskedAt: ago(100),
    client: { id: "k1", shortId: 1, fullName: LONG, phone: "+992900000006" }, property: { id: "p1", title: `Участок ${"очень длинное название ".repeat(4)}` } },
  { id: "t2", clientId: "k2", type: "CALL", nextActionDate: at(11), nextAction: "Перезвонить", taskCancelledAt: null, client: { id: "k2", shortId: 2, fullName: "Клиент Два", phone: "+992900000009" }, property: null },
];
const activeCall = { channelId: "X1", clientId: "k1", clientShortId: 1, clientName: LONG, dialingTo: "+992900000002", state: "ringing_client",
  startedAt: ago(0.2), answeredAt: null, talkSeconds: 0, outcome: null, cancelled: false, clientRang: false };

async function stub(page: Page, look: boolean, opts: { active?: boolean } = {}) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((u) => u.pathname === "/api/v1/calls", (r) => r.fulfill({ json: { items: calls, total: 2, page: 1, pageSize: 20, ownOnly: false } }));
  await page.route((u) => u.pathname === "/api/v1/calls/incoming", (r) => r.fulfill({ json: { items: incoming, total: 1, periodTotal: 1, missed: 1, unqualified: 0, page: 1, pageSize: 20, days: 30 } }));
  await page.route((u) => u.pathname === "/api/v1/calls/feed", (r) => r.fulfill({ json: { items: [], nextBefore: null } }));
  await page.route((u) => u.pathname === "/api/v1/calls/telephony/dashboard", (r) => r.fulfill({ json: dashboard }));
  await page.route((u) => u.pathname === "/api/v1/me/queue-pause", (r) => r.request().method() === "GET" ? r.fulfill({ json: { available: true, paused: false, queue: "600" } }) : r.fallback());
  await page.route((u) => u.pathname === "/api/v1/calendar/tasks", (r) => r.fulfill({ json: tasks }));
  if (opts.active) await page.route((u) => u.pathname === "/api/v1/me/active-call", (r) => r.fulfill({ json: activeCall }));
}

const SCREENS = [
  { url: "/calls", ready: ".ry-call", check: ".ry-calls-top, .ry-chats-switch, .ry-call-row, .ry-call-action, .ry-call-flags, [data-clean-calls-summary]" },
  { url: "/telephony", ready: ".ry-tel-queue", check: ".ry-calls-top, .ry-tel-queue, .ry-call-row, .ry-call-action, .tiles .tile, .ry-row" },
  { url: "/calendar", ready: ".ry-calendar .cal", check: ".ry-calendar .card, .ry-calendar .cal, .ry-calendar .list > .row, .ry-calendar .act" },
];

for (const screen of SCREENS) {
  test(`новый вид ${screen.url}: без горизонтальной прокрутки на всех ширинах @smoke`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    // Девять заходов на страницу: на dev-сервере стенда это дольше общего лимита 30 с.
    test.setTimeout(240_000);
    await stub(page, true);
    for (const width of LOOK_WIDTHS) {
      // Каждая ширина — свой заход: ниже 1024 «Звонки» рисует мобильный экран.
      await page.setViewportSize({ width, height: 900 });
      await page.goto(screen.url);
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
      await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 20_000 });
      await expectNoOverflowAt(page, width, screen.check, { strips: ".hscroll, .lane, .tbl-wrap" });
    }
  });
}

test("новый вид: окно звонка на всех ширинах — «Отменить» крупная, красная и не перекрыта меню", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await stub(page, true, { active: true });
  await page.goto("/calls");
  const end = page.locator('.ry-cw[data-ry-section="calls"] .cw2-btn.end');
  await expect(end).toBeVisible({ timeout: 20_000 });
  for (const width of LOOK_WIDTHS) {
    await expectNoOverflowAt(page, width, ".ry-cw .cw2, .ry-cw .cw2-btn, .ry-cw .cw2-quiet");
    const box = await end.boundingBox();
    expect(box?.height ?? 0, `высота кнопки на ${width}px`).toBeGreaterThanOrEqual(56);
    // Кнопка сверху стопки: в её середине — она сама, а не нижнее меню.
    const onTop = await end.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(onTop, `кнопка перекрыта на ${width}px`).toBe(true);
    expect(await end.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\((17[0-9]|1[89]\d|2\d\d), \d{1,2}, \d{1,2}\)$/);
  }
});

/**
 * Ревью PR 285 (блокер): объяснение «звонок не прошёл» у кнопки «Перезвонить»
 * обрезалось карточкой журнала (overflow:hidden). Станция подменена отказом 503 —
 * окно ошибки обязано быть видно ЦЕЛИКОМ: в пределах экрана и не перекрыто/не
 * обрезано (в точке у нижнего края окна — само окно).
 */
test("новый вид: окно «звонок не прошёл» у «Перезвонить» видно целиком на 1280, 800 и 390", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  test.setTimeout(120_000);
  await stub(page, true);
  await page.route((u) => /\/api\/v1\/clients\/[^/]+\/call$/.test(u.pathname),
    (r) => r.fulfill({ status: 503, json: { error: "станция не отвечает (проверка)" } }));
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/calls");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    const redial = page.locator(".ry-call button.ry-call-act", { hasText: "Перезвонить" }).first();
    await expect(redial).toBeVisible({ timeout: 20_000 });
    // Кнопку — в середину экрана ДО нажатия; само окно не прокручиваем: прокрутка к
    // нему сдвинула бы содержимое режущей карточки и спрятала бы обрезку.
    await redial.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await redial.click();
    // Окно ошибки CallClientButton: <div окна> > <div строки> > <p текста>.
    const popup = page.locator("p", { hasText: "Нет связи с телефонной станцией" }).first().locator("xpath=../..");
    await expect(popup).toBeVisible();
    // Окно у нижней строки уходит ниже края — человек долистывает страницу. Листаем
    // ту же прокрутку, что и он (рамку приложения или окно), но не режущую карточку.
    await popup.evaluate((el) => {
      const over = el.getBoundingClientRect().bottom - window.innerHeight + 8;
      if (over <= 0) return;
      const frame = el.closest(".clean-frame") as HTMLElement | null;
      if (frame && frame.scrollHeight > frame.clientHeight) frame.scrollTop += over; else window.scrollBy(0, over);
    });
    const seen = await popup.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const inside = (x: number, y: number) => { const hit = document.elementFromPoint(x, y); return !!hit && el.contains(hit); };
      // Предок, который режет содержимое (overflow hidden/clip), и окно за его краем —
      // это и есть обрезка карточкой, даже если сейчас под точкой проверки пусто.
      const clippedBy: string[] = [];
      // Окно с position:fixed (телефон) предки без transform не режут — проверять нечего.
      const fixed = getComputedStyle(el).position === "fixed";
      for (let n = el.parentElement; !fixed && n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (!/hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) continue;
        const a = n.getBoundingClientRect();
        if (r.top < a.top - 1 || r.bottom > a.bottom + 1 || r.left < a.left - 1 || r.right > a.right + 1) clippedBy.push(String(n.className).slice(0, 40));
      }
      return {
        clippedBy,
        // ±1 px: дробные координаты после прокрутки рамки к окну.
        inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
        bottomVisible: inside(r.left + r.width / 2, r.bottom - 3),
        topVisible: inside(r.left + r.width / 2, r.top + 3),
      };
    });
    expect(seen, `окно ошибки звонка на ${width}px`).toEqual({ clippedBy: [], inViewport: true, bottomVisible: true, topVisible: true });
  }
});

test("без признака с сервера разметки нового вида в звонках, телефонии и календаре нет", async ({ page }) => {
  await stub(page, false, { active: true });
  for (const url of ["/calls", "/telephony", "/calendar"]) {
    await page.goto(url);
    await expect(page.locator("main#main")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
    await expect(page.locator("[data-ry-section]")).toHaveCount(0);
    await expect(page.locator(".ry-call, .ry-calls-top, .ry-cw")).toHaveCount(0);
  }
});
