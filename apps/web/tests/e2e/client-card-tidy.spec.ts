import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";

/**
 * Карточка клиента после уборки (22.11.2026): нет «Запроса покупателя», «Следующего шага», «Показано N из N».
 * Работает только на изолированном стенде с засеянным покупателем (CARD_CLIENT_ID). С CARD_SHOTS_DIR + CARD_SHOTS_NAME
 * кладёт кадры (390 с полной высотой и 1440, светлая тема). CARD_PHASE=before — только кадры, без проверок.
 */
const CLIENT_ID = process.env.CARD_CLIENT_ID;
const SHOTS = process.env.CARD_SHOTS_DIR;
const NAME = process.env.CARD_SHOTS_NAME ?? "after";
const BEFORE = process.env.CARD_PHASE === "before";
const GONE = ["Запрос покупателя", "Уточнить пожелания", "Следующий шаг", "Показано 0 из", "Взять из разговора", "Записать результат"];

for (const [label, width, height] of [["390", 390, 844], ["1440", 1440, 1000]] as const) {
  test(`карточка клиента ${label}: уборка @card-tidy`, async ({ browser }) => {
    test.skip(!CLIENT_ID, "нужен CARD_CLIENT_ID засеянного покупателя");
    const context = await contextForRole(browser, "AGENT", { viewport: { width, height }, deviceScaleFactor: 2, colorScheme: "light", serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(`/clients/${CLIENT_ID}`);
    await expect(page.getByRole("heading", { name: /Фируза/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("С сайтов объявлений")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    if (!BEFORE) {
      const text = await page.locator("body").innerText();
      for (const bad of GONE) expect(text, bad).not.toContain(bad);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "горизонтальной прокрутки нет").toBeLessThanOrEqual(1);
    }
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      // Оболочка прокручивает внутренний контейнер, а не страницу: растим окно до высоты всего содержимого.
      const full = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll<HTMLElement>("*")].filter(e => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== "visible").map(e => e.scrollHeight + e.getBoundingClientRect().top)));
      await page.setViewportSize({ width, height: Math.min(Math.ceil(full) + 40, 8000) });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, `${NAME}-${label}.png`) });
    }
    await context.close();
  });
}
