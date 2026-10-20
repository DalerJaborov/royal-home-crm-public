import { phoneFor, SEED_PASSWORD } from "./parity-core.mjs";
import { isDeepStrictEqual } from "node:util";

// This mode changes only its seed actor's theme and restores the complete
// original preferences. Never point it at the owner's stand or production.
export function assertLiveTarget(base, isolatedSeed = process.env.AUDIT_ISOLATED_SEED === "1") {
  const url = new URL(base);
  const allowedPort = url.port === "5294" || (url.port === "5305" && isolatedSeed);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !allowedPort || url.username || url.password) {
    throw new Error("--live-ui requires isolated loopback QA (5294, or 5305 with AUDIT_ISOLATED_SEED=1)");
  }
}

export async function loginLive(ctx, base, role, theme) {
  assertLiveTarget(base);
  await ctx.addInitScript(() => {
    localStorage.setItem("rh:greeting:skip", "1");
    localStorage.setItem("royal-home-push-nudge-dismissed-until", String(Date.now() + 86_400_000));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`setup pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`setup console: ${message.text()}`); });
  let original;
  let headers;
  let changed = false;
  const restore = async () => {
    if (!changed) return;
    const response = await ctx.request.put(`${base}/api/v1/me/preferences`, { headers, data: original });
    if (!response.ok()) throw new Error(`restore QA preferences: HTTP ${response.status()}`);
    const profile = await ctx.request.get(`${base}/api/v1/me`, { headers });
    if (!profile.ok() || !isDeepStrictEqual((await profile.json()).preferences ?? {}, original)) {
      throw new Error("QA preferences restoration was not confirmed");
    }
    changed = false;
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/login`);
    await page.getByLabel("Рабочий телефон").fill(phoneFor(role));
    await page.getByRole("button", { name: "Далее", exact: true }).click();
    await page.getByLabel("Пароль", { exact: true }).fill(SEED_PASSWORD);
    const login = page.waitForResponse((response) => response.url().endsWith("/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    const response = await login;
    if (!response.ok()) throw new Error(`UI login ${role}: HTTP ${response.status()}`);
    const auth = await response.json();
    if (!auth.accessToken || !auth.agent) throw new Error("UI login requires a complete seed session");
    headers = { Authorization: `Bearer ${auth.accessToken}` };
    const profile = await ctx.request.get(`${base}/api/v1/me`, { headers });
    if (!profile.ok()) throw new Error(`QA profile: HTTP ${profile.status()}`);
    original = (await profile.json()).preferences ?? {};
    await page.locator('[data-topbar-theme]:visible').first().waitFor();
    const expected = `royal-home-2026-${theme}`;
    await page.waitForFunction(() => !document.querySelector('.clean[aria-busy="true"]'));
    if (await page.locator("html").getAttribute("data-theme") !== expected) {
      changed = true; // Also restore if the click or subsequent wait fails.
      const saved = page.waitForResponse((res) => res.url().endsWith("/me/preferences") && res.request().method() === "PUT");
      await page.locator('[data-topbar-theme]:visible').first().click();
      if (!(await saved).ok()) throw new Error("QA theme was not persisted");
    }
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, expected);
    return { auth, restore, errors, originalPreferences: structuredClone(original), notePreferenceWrite: () => { changed = true; } };
  } catch (error) {
    await restore();
    throw error;
  } finally {
    await page.close();
  }
}
