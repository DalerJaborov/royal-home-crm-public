import { test, expect } from "@playwright/test";
import { contextForRole, type RoleName } from "./pages/roleAuth";
import { IPHONE_UA, geometryFindings, GEOMETRY_KINDS } from "./helpers/lookGeometry";
import { LOOK_CONVERSATION_ID, stubLookVisualData } from "./helpers/lookVisualFixtures";

/* Временный отчёт: крупный текст на телефонах (не коммитится). */
const SCREENS = [
  { url: "/", ready: ".ry-today" },
  { url: "/clients", ready: '[data-ry-section="clients"]' },
  { url: "/properties", ready: ".ry-objects-head" },
  { url: `/messages?open=${LOOK_CONVERSATION_ID}`, ready: ".bub", kinds: ["ghostCall", "blur", "smallText", "fieldFrame"] },
  { url: "/finance", ready: "main#main" },
];
const ROLES = (process.env.PROBE_ROLES ?? "DIRECTOR,AGENT").split(",") as RoleName[];
const WIDTHS = (process.env.PROBE_WIDTHS ?? "360,390,414,430").split(",").map(Number);
const SIZES = (process.env.PROBE_SIZES ?? "large,xlarge").split(",") as ("large" | "xlarge")[];
const THEMES = (process.env.PROBE_THEMES ?? "light,dark").split(",") as ("light" | "dark")[];

for (const textSize of SIZES) for (const theme of THEMES) for (const role of ROLES) {
  test(`${role} ${textSize} ${theme}`, async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    for (const width of WIDTHS) {
      const context = await contextForRole(browser, role, { viewport: { width, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: theme });
      const page = await context.newPage();
      await stubLookVisualData(page, { textSize });
      for (const s of SCREENS) {
        try {
          await page.goto(s.url, { waitUntil: "domcontentloaded" });
          await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 25_000 });
          await expect(page.locator(s.ready).first()).toBeVisible({ timeout: 25_000 });
          await page.waitForTimeout(800);
          await page.evaluate(() => document.fonts.ready.then(() => true));
          const kinds = (s.kinds ?? GEOMETRY_KINDS.filter((k) => !(width >= 768 && k === "hole"))) as never;
          const f = await geometryFindings(page, { kinds });
          for (const x of f) console.log(`FIND ${role} ${textSize} ${theme} @${width} ${s.url} :: ${x}`);
        } catch (e) { console.log(`ERR ${role} ${textSize} ${theme} @${width} ${s.url} :: ${String(e).slice(0, 140)}`); }
      }
      await context.close();
    }
  });
}
