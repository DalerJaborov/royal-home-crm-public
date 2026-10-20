import { test, expect } from "@playwright/test";
import { loginLive } from "../../scripts/lib/parity-live-session.mjs";

// Requires a VITE_AGENT_MOBILE_PREVIEW=1 build on the isolated seed. This does
// not mock identity, rollout permissions, or the production device guard.
test.beforeEach(async ({}, testInfo) => {
  const target = new URL(testInfo.project.use.baseURL ?? "http://invalid");
  test.skip(process.env.E2E_AGENT_MOBILE_PREVIEW !== "1" || process.env.E2E_ISOLATED_SEED !== "1"
    || target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname)
    || target.port !== "5305" || !!target.username || !!target.password,
  "This suite is only for an explicitly enabled isolated agent preview, never ordinary or production QA.");
});

for (const theme of ["light", "night"]) for (const width of [360, 430]) {
  test(`Agent preview: profile and inbox fit a ${width}px phone in ${theme}`, async ({ page, context }, testInfo) => {
    process.env.AUDIT_ISOLATED_SEED = "1";
    const base = testInfo.project.use.baseURL!;
    const session = await loginLive(context, base, "agent", theme);
    const blocked: string[] = [];
    const technical = new Set(["/api/v1/auth/refresh", "/api/v1/events/ticket", "/api/v1/_seen", "/api/v1/dashboard/counters/seen", "/api/v1/me/preferences"]);
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (["GET", "HEAD", "OPTIONS"].includes(request.method()) || technical.has(path)) return route.continue();
      blocked.push(`${request.method()} ${path}`);
      return route.abort("blockedbyclient");
    });
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/profile?shell=clean&agentMobilePreview=1`);
      await expect(page.locator("html")).toHaveAttribute("data-shell", "clean");
      const duration = page.locator(".clean-profile-page .mod select").first();
      await expect(duration).toBeVisible();
      await expect.poll(() => duration.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const pause = page.getByRole("button", { name: "Не принимать лиды", exact: true });
      await expect(pause).toBeVisible();
      const bounds = await pause.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);

      await page.goto(`${base}/messages`);
      await expect(page.locator(".clean-inbox-filters")).toBeVisible();
      await page.locator(".clean-inbox-filters summary").click();
      const channel = page.getByRole("combobox", { name: /^Канал переписки/ });
      await expect(channel).toBeVisible();
      await expect.poll(() => channel.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(blocked).toEqual([]);
    } finally {
      await session.restore();
    }
  });
}
