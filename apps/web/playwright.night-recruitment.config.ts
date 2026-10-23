import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "night-recruitment-limits.spec.ts", workers: 1, timeout: 30_000, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5198", channel: "chrome", headless: true, trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5198 --strictPort", url: "http://127.0.0.1:5198", reuseExistingServer: false, timeout: 120_000 },
});
