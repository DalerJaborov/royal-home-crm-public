import { test, expect, type Page } from "@playwright/test";

/**
 * НОВЫЙ ВИД, ПК — боковая переписка на карточке клиента (21.11.2026, кадры владельца):
 *  а) в длинной переписке можно прокрутить до первого сообщения;
 *  б) внизу ничего не обрезается на ширине панели 320–480 px;
 *  в) метки канала («WhatsApp») в тексте сообщений нет.
 * Карточка клиента подменяется в ответе: данные придуманы, реальных клиентов здесь нет.
 */
const now = Date.now();
const messages = Array.from({ length: 160 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: i === 0 ? "ПЕРВОЕ сообщение переписки" : `Сообщение номер ${i}, текст подлиннее чтобы строка переносилась и занимала место`,
  at: new Date(now - (160 - i) * 60_000).toISOString(),
  ...(i % 2 === 1 ? { by: { kind: "bot" } } : {}),
}));

async function open(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
  await page.route(/\/api\/v1\/clients\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const json = await res.json();
    json.botConversation = [{ id: "e2e-conv-1", channel: "WHATSAPP", pausedUntil: null, canReply: true, messages }];
    json.telegramConversation = null;
    json.telegramDirectConversations = [];
    json.kind = json.kind ?? "BUYER";
    await route.fulfill({ response: res, json });
  });
  await page.goto(`/clients/1`);
  await page.getByRole("tab", { name: "Переписка", exact: true }).click();
  await page.getByRole("button", { name: /Открыть переписку/ }).first().click();
  await expect(page.getByRole("dialog", { name: /Переписка с/ })).toBeVisible();
}

for (const width of [1440, 1100]) {
  test(`ПК ${width}: переписку можно прокрутить к первому сообщению, нижняя строка целая, канала в тексте нет @smoke`, async ({ page }, info) => {
    test.skip(info.project.name !== "chromium", "ПК");
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const dialog = page.getByRole("dialog", { name: /Переписка с/ });
    await expect(dialog.getByText("WhatsApp", { exact: false })).toHaveCount(0);
    await expect(dialog.getByText("1 канал", { exact: false })).toHaveCount(0);

    // Лента: единственный прокручиваемый контейнер Virtuoso.
    const scroller = dialog.locator('[data-virtuoso-scroller="true"]');
    await expect(scroller).toBeVisible();
    const box = await scroller.boundingBox();
    expect(box!.height, "лента схлопнулась").toBeGreaterThan(200);
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    for (let i = 0; i < 40; i++) {
      await scroller.hover();
      await page.mouse.wheel(0, -4000);
      if (await dialog.getByText("ПЕРВОЕ сообщение переписки").isVisible()) break;
      await page.waitForTimeout(120);
    }
    await expect(dialog.getByText("ПЕРВОЕ сообщение переписки")).toBeVisible();

    // Нижняя строка: ничего не вылезает за панель, поле ввода шире кнопки.
    const panel = (await dialog.boundingBox())!;
    const compose = dialog.locator("form.compose");
    for (const el of await compose.locator("textarea, button, select").all()) {
      const b = await el.boundingBox();
      if (!b) continue;
      expect(b.x, "левее панели").toBeGreaterThanOrEqual(panel.x - 1);
      expect(b.x + b.width, "правее панели").toBeLessThanOrEqual(panel.x + panel.width + 1);
    }
    const ta = (await compose.locator("textarea").boundingBox())!;
    expect(ta.width, "поле ввода обрезано").toBeGreaterThan(120);
    await dialog.screenshot({ path: info.outputPath(`panel-${width}.png`) });
  });
}
