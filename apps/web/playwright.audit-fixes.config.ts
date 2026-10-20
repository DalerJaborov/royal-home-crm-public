import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || process.env.E2E_ISOLATED_SEED !== "1") throw new Error("Explicit isolated seed required");
const target = new URL(baseURL);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname)
  || target.port !== "5305" || target.username || target.password) throw new Error("Audit fixes are loopback5305 only");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["audit-finance.spec.ts", "audit-client-focus.spec.ts", "audit-session-privacy.spec.ts"],
  fullyParallel: false, workers: 1, retries: 0, timeout: 90_000, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, viewport: { width: 1440, height: 1000 },
    storageState: { cookies: [], origins: [] }, serviceWorkers: "block",
    actionTimeout: 15_000, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
