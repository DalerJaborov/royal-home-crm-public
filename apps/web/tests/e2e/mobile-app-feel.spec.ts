import { test, expect, type Page } from "@playwright/test";

/**
 * ТЕЛЕФОН «КАК ПРИЛОЖЕНИЕ» (21.11.2026, владелец с iPhone): клавиатура в переписке, прокрутка под окном,
 * кнопка «Назад». ВНИМАНИЕ: это ЭМУЛЯЦИЯ. Клавиатуру iOS Playwright не открывает — подменяем
 * visualViewport так, как его отдаёт Safari на iPhone (видимая область ниже и сдвинута вниз), и вдобавок
 * `innerHeight`, падающий вместе с клавиатурой (так ведёт себя WebKit на телефоне, по кадру владельца).
 * Касания — синтетические TouchEvent. Настоящий телефон проверяет /ui-check → «Открыть поле с клавиатурой».
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const detail = {
  id: "e2e-sheet-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", profileName: null, subscriberId: "peer", clientId: "00000000-0000-4000-8000-000000000001",
  clientShortId: "КЛ-1", clientPhone: null, firstContactAt: ago(500), pausedUntil: null, shieldPause: null, contact: null,
  sources: [{ id: "e2e-sheet-0", channel: "WHATSAPP", canReply: true, pausedUntil: null }],
  messages: Array.from({ length: 28 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `Сообщение для прокрутки номер ${i + 1}: достаточно длинное, чтобы занять строку-другую`,
    at: ago(60 - i),
    ...(i % 2 ? { by: { kind: "bot" }, deliveryStatus: "read" } : {}),
  })),
};
const list = {
  items: [{
    id: "e2e-sheet-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", clientShortId: "КЛ-1",
    lastMessage: { role: "user", content: "Сообщение", by: undefined }, lastMessageAt: ago(30), paused: false, awaitingHumanSince: null, pausedSince: null,
    unread: false, unreadCount: 0, messagesCount: 28, accountId: null, accountTitle: null, agentAttentionRequestedAt: null,
  }],
  page: 1, pageSize: 20, total: 1, channels: ["WHATSAPP"], accounts: [], counts: { all: 1, needsHuman: 0, paused: 0, mine: 0 }, alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } },
};

async function royalLook(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}
async function stub(page: Page) {
  await royalLook(page);
  await page.route((url) => url.pathname === "/api/v1/conversations", (route) => route.fulfill({ json: list }));
  await page.route((url) => url.pathname === "/api/v1/conversations/e2e-sheet-0" || url.pathname.startsWith("/api/v1/conversations/groups/"), (route) => route.fulfill({ json: detail }));
}

/** Клавиатура iPhone: видимая область `h` со сдвигом `top`, и `innerHeight` = `h` (как WebKit на телефоне). */
async function fakeIosKeyboard(page: Page) {
  await page.addInitScript(() => {
    const listeners: Record<string, Array<() => void>> = {};
    const full = window.innerHeight;
    const fake = {
      height: full, offsetTop: 0, offsetLeft: 0, width: window.innerWidth, scale: 1, pageTop: 0, pageLeft: 0,
      addEventListener: (type: string, cb: () => void) => { (listeners[type] ??= []).push(cb); },
      removeEventListener: (type: string, cb: () => void) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb); },
      dispatchEvent: () => true,
    };
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    Object.defineProperty(window, "innerHeight", { get: () => fake.height, configurable: true });
    (window as unknown as { __scale: (v: number) => void }).__scale = (v) => { fake.scale = v; };
    (window as unknown as { __kb: (h: number, top: number) => void }).__kb = (h, top) => {
      fake.height = h; fake.offsetTop = top;
      for (const type of ["resize", "scroll"]) for (const cb of listeners[type] ?? []) cb();
    };
  });
}
const setKb = (page: Page, h: number, top: number) =>
  page.evaluate(([a, b]) => (window as unknown as { __kb: (h: number, t: number) => void }).__kb(a, b), [h, top] as const);

async function openChatDirect(page: Page) {
  await stub(page);
  await page.goto("/messages?open=e2e-sheet-0");
  await expect(page.locator(".ry-chat-head")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".clean-conversation .bub").first()).toBeVisible();
}

/** Синтетическое касание: старт в середине элемента и движение на `dy`. Возвращает, отменено ли движение. */
async function drag(page: Page, selector: string, dy: number): Promise<boolean> {
  return page.evaluate(([sel, delta]) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height / 2, 20);
    // У настольного WebKit нет конструктора Touch: событие с тем же именем и полями касания читают и наш
    // слушатель документа, и обработчики React.
    const fire = (type: string, cy: number | null) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      const t = cy === null ? [] : [{ identifier: 1, target: el, clientX: x, clientY: cy, pageX: x, pageY: cy, screenX: x, screenY: cy }];
      Object.defineProperties(ev, { touches: { value: t }, targetTouches: { value: t }, changedTouches: { value: t } });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    fire("touchstart", y);
    let prevented = false;
    for (let i = 1; i <= 5; i++) if (fire("touchmove", y + (delta * i) / 5)) prevented = true;
    return prevented;
  }, [selector, dy] as const);
}
async function release(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const ev = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperties(ev, { touches: { value: [] }, targetTouches: { value: [] }, changedTouches: { value: [] } });
    el.dispatchEvent(ev);
  }, selector);
}

test.describe("телефон как приложение", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "webkit", "только webkit (iPhone): механика Safari");
    // Dev-сервер собирает раздел «Сообщения» при первом заходе дольше 30 секунд по умолчанию.
    test.setTimeout(120_000);
  });
  test.use({ viewport: { width: 390, height: 844 } });

  test("клавиатура: переписка стоит в видимой области, поле у её низа, лента на месте @smoke", async ({ page }) => {
    await fakeIosKeyboard(page);
    await openChatDirect(page);
    const layer = page.getByRole("region", { name: /^Диалог/ });
    const field = page.locator(".ry-chat-compose textarea").first();
    const lastBubble = page.locator(".clean-conversation .bub").last();
    await field.focus();
    // Safari открыл клавиатуру 336 px и сдвинул видимую область до самого низа окна.
    await setKb(page, 508, 336);
    await expect.poll(async () => Math.round((await layer.boundingBox())!.y), { message: "верх переписки = верх видимой области" }).toBe(336);
    const box = (await layer.boundingBox())!;
    expect(Math.round(box.y + box.height), "низ переписки = верх клавиатуры").toBe(844);
    const f = (await field.boundingBox())!;
    const gap = 844 - (f.y + f.height);
    expect(gap, "под полем нет пустоты до клавиатуры").toBeLessThanOrEqual(24);
    expect(gap).toBeGreaterThanOrEqual(0);
    const head = (await page.locator(".ry-chat-head").boundingBox())!;
    expect(Math.round(head.y), "шапка у верха видимой области").toBeGreaterThanOrEqual(336);
    await expect.poll(async () => { const b = (await lastBubble.boundingBox())!; return b.y + b.height <= f.y + 1 && b.y >= 336; },
      { message: "последнее сообщение видно над полем, лента не уехала вверх" }).toBe(true);
    // Клавиатура частично сдвинула область — та же правда.
    await setKb(page, 448, 300);
    await expect.poll(async () => Math.round((await layer.boundingBox())!.y)).toBe(300);
    // Клавиатура закрылась — всё на месте.
    await setKb(page, 844, 0);
    await expect.poll(async () => Math.round((await layer.boundingBox())!.y)).toBe(0);
    expect(Math.round((await layer.boundingBox())!.height)).toBe(844);
  });

  test("прокрутка: палец двигает только ленту, страница и видимая область не едут @smoke", async ({ page }) => {
    await openChatDirect(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).position), "страница под перепиской заблокирована").toBe("fixed");
    // По шапке и полю ввода прокручивать нечего: движение гасится (иначе при клавиатуре ехала видимая область).
    expect(await drag(page, ".ry-chat-head", 120)).toBe(true);
    await release(page, ".ry-chat-head");
    expect(await drag(page, ".ry-chat-compose textarea", -120)).toBe(true);
    await release(page, ".ry-chat-compose textarea");
    const thread = ".clean-conversation .thread";
    const canScroll = await page.evaluate((sel) => { const t = document.querySelector(sel) as HTMLElement; return t.scrollHeight - t.clientHeight; }, thread);
    expect(canScroll, "лента длиннее экрана — есть что листать").toBeGreaterThan(100);
    // Лента посередине — её прокрутка не гасится.
    await page.evaluate((sel) => { const t = document.querySelector(sel) as HTMLElement; t.scrollTop = Math.floor((t.scrollHeight - t.clientHeight) / 2); }, thread);
    expect(await drag(page, thread, 60)).toBe(false);
    await release(page, thread);
    // Лента в самом верху, палец вниз — дальше жест не уходит.
    await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 0; }, thread);
    expect(await drag(page, thread, 120)).toBe(true);
    await release(page, thread);
  });

  test("увеличенная страница (щипок): палец водит по ней свободно, ловушка не гасит", async ({ page }) => {
    await fakeIosKeyboard(page);
    await openChatDirect(page);
    expect(await drag(page, ".ry-chat-head", 120), "без увеличения шапка не тянет экран").toBe(true);
    await release(page, ".ry-chat-head");
    await page.evaluate(() => (window as unknown as { __scale: (v: number) => void }).__scale(2));
    expect(await drag(page, ".ry-chat-head", 120), "при увеличении жест свободен — фото и текст не застревают").toBe(false);
    await release(page, ".ry-chat-head");
  });

  test("шторка: жест внутри неё не двигает страницу под ней @smoke", async ({ page }) => {
    await royalLook(page);
    await page.goto("/ui-check");
    const heading = page.getByRole("heading", { name: "Проверка экрана" });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Открыть пробную шторку" }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    const before = (await heading.boundingBox())!.y;
    // Палец ведёт вниз по шапке шторки: «потянуть-обновить» страницы под ней раньше растягивался вслед.
    await drag(page, '[role="dialog"] .sheet-h', 200);
    const during = (await heading.boundingBox())!.y;
    await release(page, '[role="dialog"] .sheet-h');
    expect(Math.round(during), "страница под шторкой не сдвинулась вслед за пальцем").toBe(Math.round(before));
  });

  test("«Назад» из переписки, открытой прямой ссылкой, ведёт в список чатов @smoke", async ({ page }) => {
    await openChatDirect(page);
    await page.locator(".ry-chat-head button").first().click();
    await expect(page.locator(".ry-chat-head")).toHaveCount(0);
    await expect(page).toHaveURL(/\/messages$/);
    await expect(page.locator('section[aria-label="Диалоги"]')).toBeVisible();
  });

  test("«Назад» из переписки, открытой из списка, — шаг назад к тому же списку", async ({ page }) => {
    await stub(page);
    await page.goto("/messages");
    await page.locator(".ry-chat-row").first().click({ timeout: 60_000 });
    await expect(page.locator(".ry-chat-head")).toBeVisible({ timeout: 30_000 });
    const depth = await page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? -1);
    await page.locator(".ry-chat-head button").first().click();
    await expect(page.locator(".ry-chat-head")).toHaveCount(0);
    await expect(page).toHaveURL(/\/messages$/);
    expect(await page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx ?? -1), "шаг назад по истории, а не новая запись").toBe(depth - 1);
  });

  test("/ui-check: пробное поле с клавиатурой — каркас в видимой области, цифры над полем", async ({ page }) => {
    await fakeIosKeyboard(page);
    await royalLook(page);
    await page.goto("/ui-check");
    await page.getByRole("button", { name: "Открыть поле с клавиатурой" }).click({ timeout: 60_000 });
    const probe = page.locator("[data-ui-check-keyboard]");
    await expect(probe).toBeVisible();
    await page.getByRole("textbox", { name: "Пробное поле" }).focus();
    await setKb(page, 508, 336);
    await expect.poll(async () => Math.round((await probe.boundingBox())!.y)).toBe(336);
    await expect(probe.getByText("Пустота под полем, px")).toBeVisible();
    await expect(probe.getByText("Клавиатура: новый / старый расчёт")).toBeVisible();
  });
});
