import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "night-audit-live.spec.ts",
  workers: 1, retries: 0, timeout: 120_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5305", channel: "chrome", headless: true, serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: [
    { command: "node --import tsx ../api/tests/nightAuditStand.mts", url: "http://127.0.0.1:4805/api/v1/health", timeout: 120_000,
      env: { NODE_ENV: "test", DATABASE_URL: "postgresql://postgres:test-night-audit@127.0.0.1:15439/audit_web", JWT_ACCESS_SECRET: "test-night-access-secret-20261024", JWT_REFRESH_SECRET: "test-night-refresh-secret-20261024", SETTINGS_ENCRYPTION_KEY: "a".repeat(64), LOGIN_CODE_DEV_ECHO: "1", API_RATE_LIMIT: "1000000", CORS_ORIGIN: "http://127.0.0.1:5305" } },
    { command: "npm run dev -- --host 127.0.0.1 --port 5305 --strictPort", url: "http://127.0.0.1:5305", timeout: 120_000,
      env: { VITE_API_PROXY: "http://127.0.0.1:4805" } },
  ],
});
