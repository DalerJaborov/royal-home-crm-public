import { defineConfig, devices } from "@playwright/test";

// Rollout is a stand-wide switch. Never mix these cases with parallel smoke,
// mobile or production suites; the existing server must be an isolated seed stand.
// 5284 is the owner's visible preview. Rollout mutations run on a separate DB/API.
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) throw new Error("Provide E2E_BASE_URL for an isolated local QA seed stand.");
const target = new URL(baseURL);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname) || !target.port || target.port === "5284" || target.username || target.password || process.env.E2E_ISOLATED_SEED !== "1") {
  throw new Error("Royal Clean checks require an explicit isolated local seed stand; the owner's 5284 preview is excluded.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  // The rollout suite performs real PUTs. It is excluded from ordinary QA runs.
  testMatch: process.env.E2E_ALLOW_ROLLOUT_WRITES === "1"
    ? ["clean-shell.spec.ts", "finance-expenses.spec.ts"] : ["finance-expenses.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1440, height: 1000 },
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "royal-clean" }],
});
