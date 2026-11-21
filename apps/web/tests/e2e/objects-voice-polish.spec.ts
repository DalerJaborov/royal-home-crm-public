import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * «НОВЫЙ ВИД» — список «Объекты» и голосовые в переписке (21.11.2026, кадры владельца с iPhone):
 *  1. чипы «Ждут проверки» и «Задержка подготовки» — спокойные, в одну строку, без значка тревоги;
 *     у объекта на монтаже нет «0 дн. в продаже»;
 *  2. голосовое прямо в пузыре, без белой подложки; отказ доставки подписан словами.
 * Кадры — в SHOTS_DIR, если задан.
 */
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** 5 секунд тишины, 8 кГц моно: достаточно, чтобы плеер узнал длину. */
function silentWav(sec = 5): Buffer {
  const rate = 8000, n = rate * sec, data = Buffer.alloc(n * 2), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function look(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test.describe("новый вид, 390: объекты и голосовые", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "нужен проект chromium");
  });
  test.use({ viewport: { width: 390, height: 844 } });

  test("список объектов: спокойные чипы, без «0 дн. в продаже» на монтаже @smoke", async ({ page }) => {
    await look(page);
    await page.route((u) => u.pathname === "/api/v1/properties/summary", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), overduePipelineCount: 2 } });
    });
    await page.route((u) => u.pathname === "/api/v1/properties", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.items?.[0]) {
        body.items[0] = { ...body.items[0], status: "EDITING", listingAcceptedAt: new Date().toISOString(), demandCount: 8, soldAt: null, videoHandoffBrief: { state: "queued", position: 6 } };
      }
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/properties");
    await expect(page.locator(".ry-objects-head")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".ry-obj-card").first()).toBeVisible();
    await expect(page.getByText("0 дн. в продаже")).toHaveCount(0);
    await expect(page.locator(".ry-objects-head svg")).toHaveCount(await page.locator(".ry-objects-head .ry-btn svg, .ry-objects-head a svg").count());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "objects-390-after");
  });

  test("голосовое в пузыре и отказ доставки словами @smoke", async ({ page }) => {
    await look(page);
    const detail = {
      id: "e2e-voice-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", profileName: null, subscriberId: "peer", clientId: "00000000-0000-4000-8000-000000000001",
      clientShortId: "КЛ-1", clientPhone: null, firstContactAt: ago(500), pausedUntil: null, shieldPause: null, contact: null,
      sources: [{ id: "e2e-voice-0", channel: "WHATSAPP", canReply: true, pausedUntil: null }],
      messages: [
        { role: "assistant", content: "Умруз ман кабул мекунам", at: ago(90), by: { kind: "bot" }, deliveryStatus: "read" },
        { role: "assistant", content: "[🎤 голосовое]", at: ago(60), by: { kind: "bot" }, deliveryStatus: "failed", attachments: [{ kind: "audio", mime: "audio/ogg", file: null, url: "/uploads/e2e-voice.wav" }] },
        { role: "assistant", content: "[🎤 голосовое]", at: ago(58), by: { kind: "bot" }, deliveryStatus: "delivered", attachments: [{ kind: "audio", mime: "audio/ogg", file: null, url: "/uploads/e2e-voice.wav" }] },
        { role: "user", content: "[🎤 голосовое]", at: ago(30), attachments: [{ kind: "audio", mime: "audio/ogg", file: null, url: "/uploads/e2e-voice.wav" }] },
      ],
    };
    const list = {
      items: [{ id: "e2e-voice-0", channel: "WHATSAPP", name: "Покупатель из WhatsApp", clientShortId: "КЛ-1", lastMessage: { role: "user", content: "x" }, lastMessageAt: ago(30), paused: false, awaitingHumanSince: null, pausedSince: null, unread: false, unreadCount: 0, messagesCount: 4, accountId: null, accountTitle: null, agentAttentionRequestedAt: null }],
      page: 1, pageSize: 20, total: 1, channels: ["WHATSAPP"], accounts: [], counts: { all: 1, needsHuman: 0, paused: 0, mine: 0 }, alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } },
    };
    await page.route((u) => u.pathname === "/api/v1/conversations", (r) => r.fulfill({ json: list }));
    await page.route((u) => u.pathname === "/api/v1/conversations/e2e-voice-0" || u.pathname.startsWith("/api/v1/conversations/groups/"), (r) => r.fulfill({ json: detail }));
    await page.route("**/uploads/e2e-voice.wav", (r) => r.fulfill({ body: silentWav(), contentType: "audio/wav" }));
    await page.goto("/messages?open=e2e-voice-0");
    await expect(page.locator(".clean-conversation .bub").first()).toBeVisible({ timeout: 30_000 });
    const players = page.locator("[data-voice-in-bubble] [data-testid='rh-audio']");
    await expect(players).toHaveCount(3);
    await expect(page.getByTestId("rh-audio-clock").first()).toContainText("0:05", { timeout: 10_000 });
    await expect(page.getByText("Не доставлено")).toHaveCount(1);
    // Подложки нет: у плеера не задан фон-плашка (в пузыре цвета берутся у пузыря).
    expect(await players.first().evaluate((el) => el.className)).not.toContain("bg-[var(--rh-ui-hover)]");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "voice-390-after");
  });
});
