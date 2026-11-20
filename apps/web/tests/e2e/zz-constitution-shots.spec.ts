import { test, expect, type Page } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";
import { IPHONE_UA } from "./helpers/lookGeometry";
import { LOOK_CONVERSATION_ID, stubLookVisualData } from "./helpers/lookVisualFixtures";

/* Временный съёмщик кадров «до/после» для пачки C (не коммитится). */
const OUT = process.env.SHOTS_DIR ?? "D:/CRM/docs/design/oblik-2026-11-17/constitution/after2";
const ONLY = (process.env.SHOTS_ONLY ?? "").split(",").filter(Boolean);
const WIDTHS = (process.env.SHOTS_WIDTHS ?? "320,390,1440").split(",").map(Number);
const THEMES = (process.env.SHOTS_THEMES ?? "light,dark").split(",") as ("light" | "dark")[];
const TEXT = process.env.SHOTS_TEXT as "large" | "xlarge" | undefined;
const SCREENS_ALL = [
  { name: "home", url: "/", ready: ".ry-today" },
  { name: "clients", url: "/clients", ready: '[data-ry-section="clients"]' },
  { name: "object", url: "/properties", ready: ".ry-objects-head", open: true },
  { name: "chat", url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: ".bub" },
  { name: "settings", url: "/settings", ready: "main" },
  { name: "telephony", url: "/telephony", ready: "main" },
  { name: "calendar", url: "/calendar", ready: "main" },
  { name: "profile", url: "/profile", ready: "main" },
];
const SCREENS = ONLY.length ? SCREENS_ALL.filter((s) => ONLY.includes(s.name)) : SCREENS_ALL.slice(0, 5);

async function shoot(page: Page, screen: (typeof SCREENS_ALL)[number], file: string) {
  await page.goto(screen.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
  await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 30_000 });
  if (screen.open) {
    await page.waitForTimeout(1500);
    const href = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "").find((h) => /^\/properties\/(?!new$|map$)[\w-]+$/.test(h)));
    if (!href) throw new Error("нет ссылки на объект");
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
  }
  if (screen.name === "profile") {
    const tab = page.getByRole("tab", { name: /Вид и приложение/ }).first();
    if (await tab.count()) { await tab.click(); await page.locator("[data-text-size-setting]").first().scrollIntoViewIfNeeded().catch(() => {}); }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: file, fullPage: false });
}

test.describe.configure({ mode: "serial" });
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`кадры ${width} ${theme}`, async ({ browser }) => {
      test.setTimeout(300_000);
      const phone = width < 768;
      const context = await contextForRole(browser, "DIRECTOR", phone
        ? { viewport: { width, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme }
        : { viewport: { width, height: 900 }, colorScheme: theme });
      const page = await context.newPage();
      await stubLookVisualData(page, TEXT ? { textSize: TEXT } : {});
      for (const screen of SCREENS) {
        await shoot(page, screen, `${OUT}/${screen.name}-${width}-${theme}${TEXT ? `-${TEXT}` : ""}.png`).catch((e) => console.log("FAIL", screen.name, width, theme, String(e).slice(0, 200)));
      }
      await context.close();
    });
  }
}
