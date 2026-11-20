import { test, expect } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";
import { stubLookVisualData } from "./helpers/lookVisualFixtures";
test("inp", async ({ browser }) => {
  test.setTimeout(600000);
  const context = await contextForRole(browser, "DIRECTOR", { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await stubLookVisualData(page);
  for (const url of (process.env.U ?? "/calls,/archive,/vacancies,/security,/activity,/settings/roles,/team,/finance,/reports").split(",")) {
    await page.goto(url); await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal", { timeout: 25000 }); await page.waitForTimeout(1500);
    const r = await page.evaluate(() => [...document.querySelectorAll(".rh2 .scr .inp, .rh2 .scr input, .rh2 .scr select, .rh2 .scr textarea")].filter((e) => e.getBoundingClientRect().width > 2).slice(0, 6).map((e) => { const s = getComputedStyle(e); return `${e.tagName}.${String(e.className).slice(0, 40)} b=${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor} sh=${s.boxShadow.slice(0, 60)}`; }));
    console.log(`## ${url}\n${r.join("\n")}`);
  }
});
