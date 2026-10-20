import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || process.env.E2E_ISOLATED_SEED !== "1" || process.env.E2E_AGENT_MOBILE_PREVIEW !== "1") {
  throw new Error("Use the explicitly enabled isolated agent preview seed.");
}
const target = new URL(baseURL);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname)
  || target.port !== "5305" || target.username || target.password) throw new Error("Agent preview checks are loopback5305 only.");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "agent-mobile-preview.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"], baseURL, hasTouch: true,
    serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure",
  },
});
