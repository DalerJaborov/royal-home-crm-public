import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "vacancies-resume.spec.ts", workers: 1, fullyParallel: false,
  timeout: 45_000, reporter: "list", use: { baseURL: "http://127.0.0.1:5188", channel: "chrome", headless: true,
    trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5188 --strictPort", url: "http://127.0.0.1:5188", reuseExistingServer: false, timeout: 120_000 },
});
