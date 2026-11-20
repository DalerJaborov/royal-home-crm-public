import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_STRIPS, overflowingElements } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД» — раздел «Чаты» (пачка chats, 18.11.2026): сторож вёрстки.
 *
 * Ответы /ui-shell и /conversations подменяются, чтобы проверять сам экран, а
 * не содержимое базы стенда: на девяти ширинах ни список, ни открытая
 * переписка не дают горизонтальной прокрутки, шапка «Чаты» со значками и
 * строка ввода помещаются в окно (ошибка макета: «Чаты/Звонки» на телефоне
 * была шире экрана). Без признака с сервера разметки нового вида нет.
 */
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const LONG = "Очень длинное имя клиента для проверки переноса строки в списке и шапке переписки";

const items = Array.from({ length: 12 }, (_, i) => ({
  id: `e2e-chat-${i}`, channel: ["WHATSAPP", "INSTAGRAM", "TELEGRAM", "FACEBOOK"][i % 4], name: i === 0 ? LONG : `Клиент ${i + 1}`,
  clientShortId: null, lastMessage: { role: i % 2 ? "assistant" : "user", content: `Сообщение ${i + 1}: ${"очень длинный текст ".repeat(6)}`, by: i % 2 ? { kind: "bot" } : undefined },
  lastMessageAt: ago(i * 13), paused: i === 3, awaitingHumanSince: i % 3 === 0 ? ago(i * 20 + 5) : null, pausedSince: i === 3 ? ago(30) : null,
  unread: i % 2 === 0, unreadCount: i % 2 === 0 ? i + 1 : 0, messagesCount: 5, accountId: null, accountTitle: null,
  agentAttentionRequestedAt: i === 1 ? ago(2) : null,
}));
const list = {
  items, page: 1, pageSize: 20, total: items.length, channels: ["FACEBOOK", "INSTAGRAM", "TELEGRAM", "WHATSAPP"], accounts: [],
  counts: { all: 12, needsHuman: 4, paused: 1, mine: 2 },
  alerts: { longestWaitingHuman: { id: "e2e-chat-0", name: LONG, waitingMinutes: 185 }, pausedOverDay: { count: 1, names: ["Клиент 4"] } },
};
const detail = {
  id: "e2e-chat-0", channel: "WHATSAPP", name: LONG, profileName: null, subscriberId: "peer", clientId: null, clientShortId: null,
  clientPhone: null, firstContactAt: ago(500), pausedUntil: null, shieldPause: null, contact: null,
  messages: [
    { role: "user", content: `Здравствуйте! ${"Длинный вопрос про ипотеку и документы ".repeat(5)}`, at: ago(60) },
    { role: "assistant", content: "Здравствуйте! Подскажите бюджет.", at: ago(59), by: { kind: "bot" }, deliveryStatus: "read" },
    { role: "assistant", content: "Добрый день, это агент. Отправляю адрес", at: ago(30), by: { kind: "agent", agentId: "a", agentName: "Агент" }, deliveryStatus: "read" },
    { role: "user", content: "https://example.com/" + "очень-длинная-ссылка-без-пробелов-".repeat(6), at: ago(5) },
  ],
};

async function stub(page: Page, look: boolean) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: look ? { enabled: true, look: "royal" } : { enabled: true }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((url) => url.pathname === "/api/v1/conversations", (route) => route.fulfill({ json: list }));
  await page.route((url) => url.pathname === "/api/v1/conversations/e2e-chat-0", (route) => route.fulfill({ json: detail }));
}

async function noOverflow(page: Page, width: number, selectors: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { message: `горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
  // Общий помощник: край окна И край каждого режущего предка. Полоса быстрых
  // ответов — задуманная лента со своей прокруткой.
  const wide = await overflowingElements(page, selectors, `${DEFAULT_STRIPS}, .ry-chat-quick`);
  expect(wide, `элементы шире окна или своей карточки на ${width}px`).toEqual([]);
}

// По тесту на ширину (ревью #332): девять заходов в одном тесте не укладывались в
// 30 секунд на занятом стенде — теперь у каждой ширины свой тест и свой таймаут.
for (const width of WIDTHS) {
  test(`новый вид, чаты: список без горизонтальной прокрутки на ${width}px${width === 390 ? " @smoke" : ""}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
    await stub(page, true);
    // Каждая ширина — свой заход: на широком экране инбокс сам открывает первый
    // разговор (прежнее поведение), и сужение окна показало бы уже переписку.
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/messages");
    await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
    await expect(page.locator(".ry-chats-head h1")).toHaveText("Чаты", { timeout: 20_000 });
    await expect(page.locator(".ry-chat-row").first()).toBeVisible();
    await noOverflow(page, width, ".ry-chats-head, .ry-chats-switch, .ry-chats-filters, .ry-chat-row, .ry-chats-alert");
  });
}

test("новый вид, чаты: открытая переписка без горизонтальной прокрутки на всех ширинах", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await stub(page, true);
  await page.goto("/messages?open=e2e-chat-0");
  await expect(page.locator(".ry-chat-head")).toBeVisible({ timeout: 20_000 });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".ry-chat-compose textarea")).toBeVisible();
    await noOverflow(page, width, ".ry-chat-head, .ry-chat-compose, .ry-chat-quick, .clean-conversation .bub");
  }
});

test("новый вид, чаты: окно как в мессенджере — написать и отправить на 390 и 1440 @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await stub(page, true);
  const bodies: unknown[] = [];
  await page.route((url) => url.pathname === "/api/v1/conversations/e2e-chat-0/reply", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, pausedUntil: null, masked: false } });
  });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto("/messages?open=e2e-chat-0");
    const thread = page.locator(".clean-conversation");
    await expect(page.locator(".ry-chat-head")).toBeVisible({ timeout: 20_000 });
    // Лишнего в окне нет (владелец 20.11.2026): ни состояния и паузы бота, ни
    // срока паузы, ни оценки под ответами, ни выбора канала строкой.
    for (const gone of ["Бот на паузе", "Отвечает бот", "Ответ ставит бота на паузу", "Верно", "Выберите канал", "Время сообщения неизвестно"]) {
      await expect(thread.getByText(gone, { exact: false }), gone).toHaveCount(0);
    }
    // Одна круглая кнопка: микрофон, пока поле пустое; «Отправить» — когда есть текст.
    const compose = page.locator(".ry-chat-compose");
    await expect(compose.locator('button[title="Записать голосовое"]')).toBeVisible();
    await expect(compose.getByRole("button", { name: "Отправить" })).toHaveCount(0);
    await compose.getByLabel("Текст ответа").fill(`Добрый день ${width}`);
    await compose.getByRole("button", { name: "Отправить" }).click();
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    // Срок паузы уходит молча, «бессрочно», как раньше (ревью #332): без него
    // сервер дал бы директору 10 минут, и бот писал бы поверх человека.
    const body = bodies.pop() as { text: string; pausedUntil?: string };
    expect(body.text).toBe(`Добрый день ${width}`);
    expect(Date.parse(body.pausedUntil ?? "")).toBeGreaterThan(Date.now() + 5 * 365 * 24 * 3_600_000);
    await noOverflow(page, width, ".ry-chat-head, .ry-chat-compose, .clean-conversation .bub");
  }
});

test("без признака с сервера разметки нового вида в чатах нет", async ({ page }) => {
  await stub(page, false);
  await page.goto("/messages");
  await expect(page.locator("main#main")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator(".ry-chats")).toHaveCount(0);
  await expect(page.locator(".ry-chat-row")).toHaveCount(0);
});
