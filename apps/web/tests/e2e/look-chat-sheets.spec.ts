import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * «НОВЫЙ ВИД» — переписка и нижние шторки на iPhone (20.11.2026, кадры владельца):
 *  1. вложение без текста — словами, а не «[вложение без текста]»;
 *  2. стрелка «Сведения» не наезжает на текст и время;
 *  3. клавиатура: поле ввода прижато к её верху, нижнего меню в переписке нет;
 *  4. нижняя шторка доходит до низа экрана (нет серой полосы под ней).
 * Гоняется в chromium (390) и в webkit (iPhone 13): серое «под шторкой» и сдвиг
 * visualViewport — именно поведение Safari. Кадры — в SHOTS_DIR, если задан.
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string, testInfo: { project: { name: string } }) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${testInfo.project.name}.png`) });
};

const detail = {
  id: "e2e-sheet-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", profileName: null, subscriberId: "peer", clientId: "00000000-0000-4000-8000-000000000001",
  clientShortId: "КЛ-1", clientPhone: null, firstContactAt: ago(500), pausedUntil: null, shieldPause: null, contact: null,
  // Карточка клиента собирает переписку по группе каналов: без канала, куда можно ответить, поле ввода не рисуется.
  sources: [{ id: "e2e-sheet-0", channel: "WHATSAPP", canReply: true, pausedUntil: null }],
  messages: [
    { role: "user", content: "Салом", at: ago(60) },
    { role: "user", content: "[вложение без текста]", at: ago(58) },
    { role: "assistant", content: "Агент ба зудӣ ба ҳамин рақам занг мезанад, то он вақт инро ҳам бигӯед: чанд ҳуҷра ва то чанд пул.", at: ago(57), by: { kind: "bot" }, deliveryStatus: "read" },
    { role: "user", content: "Бахшишу Ма фикр кадум банк ипотекд мегайн, длинное сообщение которое переносится на несколько строк", at: ago(30) },
  ],
};
const list = {
  items: [{
    id: "e2e-sheet-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", clientShortId: "КЛ-1",
    lastMessage: { role: "user", content: "Бахшишу", by: undefined }, lastMessageAt: ago(30), paused: false, awaitingHumanSince: null, pausedSince: null,
    unread: false, unreadCount: 0, messagesCount: 4, accountId: null, accountTitle: null, agentAttentionRequestedAt: null,
  }],
  page: 1, pageSize: 20, total: 1, channels: ["WHATSAPP"], accounts: [], counts: { all: 1, needsHuman: 0, paused: 0, mine: 0 }, alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } },
};

async function stub(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route((url) => url.pathname === "/api/v1/conversations", (route) => route.fulfill({ json: list }));
  await page.route((url) => url.pathname === "/api/v1/conversations/e2e-sheet-0" || url.pathname.startsWith("/api/v1/conversations/groups/"), (route) => route.fulfill({ json: detail }));
}

async function openChat(page: Page) {
  await stub(page);
  await page.goto("/messages?open=e2e-sheet-0");
  await expect(page.locator(".ry-chat-head")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".clean-conversation .bub").first()).toBeVisible();
}

test.describe("новый вид: переписка на телефоне", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!["chromium", "webkit"].includes(testInfo.project.name), "нужен проект chromium или webkit");
  });
  test.use({ viewport: { width: 390, height: 844 } });

  test("вложение без текста — словами, без скобок @smoke", async ({ page }, testInfo) => {
    await openChat(page);
    const thread = page.locator(".clean-conversation");
    await expect(thread.getByText("[вложение без текста]", { exact: false })).toHaveCount(0);
    await expect(thread.getByText("Вложение не загрузилось")).toBeVisible();
    await shot(page, "01-thread", testInfo);
  });

  test("стрелка «Сведения» не наезжает на текст и время", async ({ page }, testInfo) => {
    await openChat(page);
    const bubbles = page.locator(".clean-conversation .bub");
    const n = await bubbles.count();
    expect(n).toBeGreaterThan(2);
    for (let i = 0; i < n; i++) {
      const bub = bubbles.nth(i);
      const more = bub.locator(".ry-msg-more");
      if ((await more.count()) === 0) continue;
      const arrow = await more.boundingBox();
      const parts = [bub.locator(".ry-msg-text"), bub.locator(".tm")];
      for (const part of parts) {
        if ((await part.count()) === 0) continue;
        // Реальные строки текста (Range), а не коробка блока: коробка может быть шире слов.
        const rects = await part.first().evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return Array.from(range.getClientRects()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
        });
        for (const r of rects) {
          const overlap = !!arrow && r.w > 0 && r.h > 0 && r.x < arrow.x + arrow.width && r.x + r.w > arrow.x && r.y < arrow.y + arrow.height && r.y + r.h > arrow.y;
          expect(overlap, `пузырь ${i}: стрелка наезжает на ${await part.first().evaluate((el) => el.className)}`).toBe(false);
        }
      }
    }
    await shot(page, "02-arrow", testInfo);
  });

  test("в открытой переписке нижнего меню нет, поле ввода прижато к низу @smoke", async ({ page }, testInfo) => {
    await openChat(page);
    await expect(page.locator("nav[data-bottomnav]")).toBeHidden();
    const box = await page.locator(".ry-chat-compose").boundingBox();
    const vh = page.viewportSize()!.height;
    expect(box!.y + box!.height).toBeGreaterThan(vh - 4);
    await shot(page, "03-compose", testInfo);
  });

  test("клавиатура: поле ввода у её верха, лента над ним, меню скрыто", async ({ page }, testInfo) => {
    // Safari при клавиатуре двигает visualViewport вниз (offsetTop > 0), а fixed-слои остаются
    // привязаны к layout viewport — поле «улетало» наверх. Подменяем visualViewport так же.
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
    await openChat(page);
    await page.locator(".ry-chat-compose textarea").focus();
    // 844 - клавиатура 336 - панель над ней 60 = 448; страница прокручена на 396.
    await page.evaluate(() => (window as unknown as { __kb: (h: number, top: number) => void }).__kb(448, 396));
    await expect(page.locator("html")).toHaveAttribute("data-clean-keyboard", "1");
    await expect(page.locator("nav[data-bottomnav]")).toBeHidden();
    await expect.poll(async () => {
      const b = await page.locator(".ry-chat-compose").boundingBox();
      return b ? Math.round(b.y + b.height) : -1;
    }, { message: "низ поля ввода = низ видимой области (offsetTop + height)" }).toBe(396 + 448);
    const thread = await page.locator(".clean-conversation .thread, .clean-conversation [data-thread]").first().boundingBox().catch(() => null);
    const compose = await page.locator(".ry-chat-compose").boundingBox();
    if (thread) expect(thread.y + thread.height).toBeLessThanOrEqual(compose!.y + 1);
    await shot(page, "04-keyboard", testInfo);
  });

  test("нижняя шторка «Сведения о сообщении» и «Подбор» доходят до низа экрана @smoke", async ({ page }, testInfo) => {
    // Нижняя шторка — только у пальца (useMobileUx): в десктопном chromium это правая панель.
    test.skip(testInfo.project.name !== "webkit", "нижняя шторка есть только в мобильном режиме");
    await openChat(page);
    await page.locator(".clean-conversation .bub").first().locator(".ry-msg-more").click();
    const info = page.getByRole("dialog").first();
    await expect(info).toBeVisible();
    await shot(page, "05-info-sheet", testInfo);
    await expectSheetReachesBottom(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Прикрепить" }).click();
    await page.getByRole("menuitem", { name: /Объект из базы/ }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await shot(page, "06-match-sheet", testInfo);
    await expectSheetReachesBottom(page);
  });

  test("видимая область выше layout viewport на 62 px: шторка и подложка опускаются до низа", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "webkit", "нижняя шторка есть только в мобильном режиме");
    // На iPhone низ layout viewport бывает выше низа экрана (серая полоса ~62 px под шторкой, кадры 20.11).
    await page.addInitScript(() => {
      const fake = { height: 906, offsetTop: 0, offsetLeft: 0, width: 390, scale: 1, pageTop: 0, pageLeft: 0,
        addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true };
      Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    });
    await openChat(page);
    await page.locator(".clean-conversation .bub").first().locator(".ry-msg-more").click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--rh-vv-over"))).toBe("62px");
    const bottoms = await page.evaluate(() => ({
      sheet: Math.round(document.querySelector(".sheet.bottom")!.getBoundingClientRect().bottom),
      back: Math.round(document.querySelector(".sheet-back")!.getBoundingClientRect().bottom),
    }));
    expect(bottoms.sheet).toBe(844 + 62);
    expect(bottoms.back).toBe(844 + 62);
    await shot(page, "07-overhang-62", testInfo);
  });
});

/** Под шторкой не должно быть ни пикселя «чужого»: её нижний край = нижний край экрана. */
async function expectSheetReachesBottom(page: Page) {
  const vh = page.viewportSize()!.height;
  const bottom = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>(".sheet.bottom, .sheet, [role='dialog']");
    return sheet ? Math.round(sheet.getBoundingClientRect().bottom) : -1;
  });
  expect(bottom, "нижний край шторки = низ экрана").toBeGreaterThanOrEqual(vh - 1);
  // Точка у самого низа экрана принадлежит шторке (или её подложке-обёртке), а не фону страницы.
  const covered = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 2);
    return !!el?.closest(".sheet, [role='dialog']");
  });
  expect(covered, "у нижней кромки экрана лежит шторка, а не страница").toBe(true);
}
