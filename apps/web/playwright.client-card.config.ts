import { defineConfig } from "@playwright/test";
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname) || new URL(baseURL).protocol !== "http:" || !new URL(baseURL).port || new URL(baseURL).port === "5284" || process.env.E2E_CLIENT_CARD_STAND !== "1") {
  throw new Error("Client-card mutations require an explicitly isolated local synthetic stand.");
}
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "client-card-workspace.spec.ts", workers: 1, fullyParallel: false,
  timeout: 60_000, retries: 0, reporter: "list",
  use: { baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
});
