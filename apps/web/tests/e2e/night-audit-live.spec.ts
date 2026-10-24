import { test, expect } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

// Genuine seeded accounts, genuine code-login and HTTP/PostgreSQL. No synthetic JWT.
// These are smoke/role boundary checks, not full workflow or physical-device proof.
for (const [role, suffix] of [["DIRECTOR", "0"], ["ADMIN", "1"], ["AGENT", "2"], ["MANAGER", "4"], ["MARKETING", "5"], ["EDITOR", "6"], ["SECURITY", "7"], ["SHAREHOLDER", "9"]] as const) {
  test(`${role}: real login, API permissions and desktop/mobile navigation`, async ({ page, baseURL }, info) => {
    expect(baseURL).toBe("http://127.0.0.1:5305");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("rh:greeting:skip", "1");
      localStorage.setItem("royal-home-push-nudge-dismissed-until", String(Date.now() + 86_400_000));
      localStorage.setItem("rh:passkey-offer-dismissed", "1");
    });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === baseURL ? route.continue() : route.abort("blockedbyclient");
    });
    const token = await loginByCode(page, `+99290000000${suffix}`);
    const headers = { Authorization: `Bearer ${token}` };
    const me = await page.request.get("/api/v1/me", { headers });
    expect(me.status()).toBe(200);
    const profile = await me.json();
    // Profile response includes permission details in a separate property; role
    // identity is asserted independently of UI labels.
    expect(profile.role ?? profile.agent?.role).toBe(role);
    const finance = await page.request.get("/api/v1/finance/forecast?month=2026-10", { headers });
    expect(finance.status()).toBe(profile.permissions.includes("finance.view") ? 200 : 403);
    const unauthenticated = await page.request.get("/api/v1/clients", { headers: { Authorization: "Bearer test-invalid-token" } });
    expect(unauthenticated.status()).toBe(401);
    if (role === "SHAREHOLDER") {
      expect(profile.readOnly).toBe(true);
      const write = await page.request.post("/api/v1/expenses", { headers, data: {} });
      expect(write.status()).toBe(403);
    }
    const visited: { width: number; path: string; finalPath: string; heading: string }[] = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      for (const path of ["/", "/profile", "/clients", "/properties", "/calendar"]) {
        await page.goto(path);
        await expect(page.locator("body")).not.toBeEmpty();
        await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
        await expect(page.getByText("Что-то пошло не так", { exact: true })).toHaveCount(0);
        await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 20_000 });
        visited.push({ width, path, finalPath: new URL(page.url()).pathname, heading: (await page.locator("h1, h2").first().innerText()).slice(0, 180) });
      }
    }
    expect(errors).toEqual([]);
    await info.attach("role-navigation-evidence", { body: JSON.stringify({ role, financeStatus: finance.status(), visited }, null, 2), contentType: "application/json" });
  });
}
