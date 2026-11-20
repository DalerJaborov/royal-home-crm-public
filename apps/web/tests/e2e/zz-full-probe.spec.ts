import { test, expect } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";
import { IPHONE_UA, geometryFindings, type GeometryKind } from "./helpers/lookGeometry";
import { stubLookVisualData } from "./helpers/lookVisualFixtures";

/* Временный отчёт: все экраны директора на 320 с видами конституции и переключателей (не коммитится). */
const URLS = (process.env.PROBE_URLS ?? "/,/clients,/sellers,/properties,/deals,/calendar,/messages,/calls,/ads,/marketing,/social-videos,/finance,/reports,/team,/oversight,/settings,/profile,/notifications,/archive,/vacancies,/security,/activity,/funnel,/sources,/insights,/health,/telephony,/integrations,/more").split(",");
const KINDS = (process.env.PROBE_KINDS ?? "smallText,smallTap,selectClip,fieldFrame,wordBreak,squeeze,overlap").split(",") as GeometryKind[];
const WIDTH = Number(process.env.PROBE_WIDTH ?? 320);

test("отчёт геометрии всех экранов", async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const context = await contextForRole(browser, "DIRECTOR", { viewport: { width: WIDTH, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  await stubLookVisualData(page, process.env.PROBE_TEXT ? { textSize: process.env.PROBE_TEXT as "xlarge" } : {});
  for (const url of URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 30_000 });
      await expect(page.locator("main#main").first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const f = await geometryFindings(page, { kinds: KINDS });
      console.log(`### ${url} (${f.length})\n` + f.join("\n"));
    } catch (e) { console.log(`### ${url} ERROR ${String(e).slice(0, 160)}`); }
  }
  await context.close();
});
