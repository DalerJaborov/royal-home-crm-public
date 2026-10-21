import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e", testMatch: "clean-surfaces.spec.ts", workers: 1,
  retries: 0, timeout: 30_000, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5307", serviceWorkers: "block", screenshot: "only-on-failure" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5307 --strictPort", url: "http://127.0.0.1:5307/tests/fixtures/clean-surfaces.html", reuseExistingServer: false },
});
