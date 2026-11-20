import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * РОДНЫЕ КОНТРОЛЫ iPHONE ПО-РУССКИ (К01/К17, 20.11.2026): запускается отдельной конфигурацией
 * `playwright.native-controls.config.ts` (WebKit iPhone 390 и Chromium с телефонным UA).
 *
 * Проверяется то, что видел владелец: «November 2026» в «Деньгах», английская дата в «Записать
 * результат», серый системный плеер голосового в чате.
 */
const phone = process.env.E2E_PHONE ?? "+992900000000";
/** Агент из сида: клиенты и чаты видны ему, а лимит кодов (5 в час на номер) не делится с директором. */
const agentPhone = process.env.E2E_AGENT_PHONE ?? "+992900000002";
const SHOTS = process.env.SHOTS_DIR;
const ENGLISH_MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b|\b\d{1,2}:\d{2}\s?(AM|PM)\b/;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function login(page: Page, who = phone) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("royal-home-device-id", "e2e-native-controls");
      localStorage.setItem("rh:greeting:skip", "1");
      localStorage.setItem("rh:passkey-offer-dismissed", "1");
    } catch { /* приватный режим */ }
  });
  await page.goto("/login");
  await page.getByLabel("Рабочий телефон").fill(who);
  const getCode = page.getByRole("button", { name: "Получить код", exact: true });
  await getCode.click();
  const codeField = page.getByRole("textbox", { name: /Код из/ });
  const cooldown = page.getByRole("status").filter({ hasText: /Новый код можно запросить через/ });
  await expect(codeField.or(cooldown).first()).toBeVisible({ timeout: 15_000 });
  if (!(await codeField.isVisible())) {
    await expect(getCode).toBeEnabled({ timeout: 75_000 });
    await getCode.click();
  }
  await expect(codeField).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

/** «Новый вид» включается ответом /ui-shell (как в new-look-*.spec.ts): без него Деньги и шторки рисуются прежним видом. */
async function royalShell(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } }) : route.fallback());
}

test.describe.configure({ mode: "serial" });

test("Деньги: месяц по-русски, а не «November 2026»", async ({ page }, testInfo) => {
  await login(page);
  await royalShell(page);
  await page.goto("/finance");
  const month = page.locator(".cef-month-picker").first();
  await expect(month).toBeVisible({ timeout: 40_000 });
  const label = month.locator("[data-ru-field-text]");
  await expect(label).toHaveText(/^[А-ЯЁ][а-яё]+ \d{4}$/);
  await expect(page.locator("body")).not.toContainText(ENGLISH_MONTH);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, `${testInfo.project.name}-money-month`);
});

test("Записать результат: поле даты и времени без английского", async ({ page }, testInfo) => {
  await login(page, agentPhone);
  await royalShell(page);
  await page.goto("/clients");
  const firstClient = page.locator('a[href^="/clients/"]').first();
  await expect(firstClient).toBeVisible({ timeout: 40_000 });
  await firstClient.click();
  const open = page.getByRole("button", { name: /Записать результат/ }).first();
  if (!(await open.isVisible().catch(() => false))) {
    // На телефоне действия карточки лежат в меню «Ещё»/«Действия».
    const more = page.getByRole("button", { name: /Ещё действия/ }).first();
    if (await more.isVisible().catch(() => false)) await more.click();
  }
  await page.getByRole("button", { name: /Записать результат/ }).first().click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  // Шторка из трёх шагов: «Что было» → «Как прошло» → «Что дальше» (дата и время следующего действия).
  await dialog.locator("textarea").first().fill("Проверка полей даты");
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  // Любое поле даты/времени в шторке — наше: lang=ru, а видимый текст без английских месяцев и AM/PM.
  const fields = dialog.locator('input[lang="ru"]');
  expect(await fields.count()).toBeGreaterThan(0);
  await expect(dialog).not.toContainText(ENGLISH_MONTH);
  for (const text of await dialog.locator("[data-ru-field-text]").allTextContents()) {
    expect(text).toMatch(/Выберите|\d{1,2}:\d{2}|\d{1,2} [а-яё]+ \d{4}/);
  }
  await shot(page, `${testInfo.project.name}-record-result`);
});

test("Чат: голосовое — свой плеер с кнопкой, временем и скоростью, не серый системный", async ({ page }, testInfo) => {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  // Тихая запись в 2 секунды (WAV): достаточно, чтобы показать длительность и сыграть.
  const n = 16000 * 2;
  const wav = Buffer.alloc(44 + n);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + n, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(n, 40);
  for (let i = 0; i < n / 2; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.05) * 3000), 44 + i * 2);

  await login(page, agentPhone);
  await royalShell(page);
  const item = {
    id: "e2e-voice-0", channel: "WHATSAPP", name: "Клиент с голосовым", clientShortId: null,
    lastMessage: { role: "user", content: "Голосовое сообщение", by: null }, lastMessageAt: ago(3), paused: false,
    awaitingHumanSince: ago(3), pausedSince: null, unread: true, unreadCount: 1, messagesCount: 2, accountId: null, accountTitle: null,
    agentAttentionRequestedAt: null,
  };
  await page.route((url) => url.pathname === "/api/v1/conversations", (route) => route.fulfill({
    json: { items: [item], page: 1, pageSize: 20, total: 1, channels: ["WHATSAPP"], accounts: [], counts: { all: 1, needsHuman: 1, paused: 0, mine: 0 }, alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } } },
  }));
  await page.route((url) => url.pathname === "/api/v1/conversations/e2e-voice-0", (route) => route.fulfill({
    json: {
      id: "e2e-voice-0", channel: "WHATSAPP", name: "Клиент с голосовым", profileName: null, subscriberId: "peer", clientId: null, clientShortId: null,
      clientPhone: null, firstContactAt: ago(60), pausedUntil: null, shieldPause: null, contact: null,
      messages: [
        { role: "user", content: "", at: ago(3), attachments: [{ kind: "audio", mime: "audio/wav", file: "e2e-voice.wav" }] },
      ],
    },
  }));
  await page.route("**/api/v1/attachments/e2e-voice.wav", (route) => route.fulfill({ body: wav, contentType: "audio/wav" }));

  // Самообновление приложения (rh-update) может перехватить первую навигацию — тогда заходим ещё раз.
  await page.goto("/messages?open=e2e-voice-0").catch(() => page.goto("/messages?open=e2e-voice-0"));
  const player = page.getByTestId("rh-audio").first();
  const failed = page.getByTestId("rh-audio-failed").first();
  await expect(player.or(failed)).toBeVisible({ timeout: 40_000 });
  expect(await page.locator("audio[controls]").count()).toBe(0); // родного серого плеера нет
  if (testInfo.project.name === "webkit-iphone") {
    // WebKit для Windows (у Playwright) не проигрывает blob-аудио вовсе (MEDIA_ERR_SRC_NOT_SUPPORTED, проверено
    // на пустой странице): настоящий iPhone играет. Здесь проверяется честная ветка отказа — строка и ссылка
    // на файл вместо вечного «00:00»; весь путь с игрой и скоростью — в проекте chromium-phone.
    // Ошибка источника приходит, когда браузер пробует файл: нажимаем ▶ (если плеер ещё не заменён строкой отказа).
    await player.getByRole("button", { name: /слушать/ }).click({ timeout: 3_000 }).catch(() => undefined);
    const gotFailed = await failed.waitFor({ timeout: 8_000 }).then(() => true, () => false);
    if (gotFailed) {
      await expect(failed).toContainText("Запись не открылась");
      await expect(failed.getByRole("link", { name: "Открыть файл" })).toBeVisible();
      await shot(page, `${testInfo.project.name}-chat-voice-failed-branch`);
      return;
    }
  }
  await expect(player).toBeVisible();
  await expect(page.getByTestId("rh-audio-clock").first()).toHaveText(/^0:00( \/ 0:0\d)?$/);
  await player.getByRole("button", { name: /слушать/ }).click();
  await expect(page.getByTestId("rh-audio-clock").first()).toHaveText(/^0:0[1-2] \/ 0:02$/, { timeout: 10_000 });
  await player.getByRole("button", { name: /Скорость/ }).click();
  await expect(player.getByRole("button", { name: /Скорость 1,5×/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, `${testInfo.project.name}-chat-voice`);
});
