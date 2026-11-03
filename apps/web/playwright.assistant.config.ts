import { defineConfig, devices } from "@playwright/test";

/**
 * Кадры карточки подтверждения помощника (П4а). Против уже поднятого стенда
 * (`node scripts/agent-stand.mjs serve`, API с LOGIN_CODE_DEV_ECHO=1): своих
 * серверов не поднимает. Сеть помощника подменяется в самом тесте — живой
 * Gemini не зовётся.
 *
 *   E2E_BASE_URL=http://localhost:5290 ASSISTANT_SHOTS=1 \
 *     npx playwright test -c playwright.assistant.config.ts
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "assistant-confirm-card.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
});
