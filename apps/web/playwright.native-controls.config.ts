import { defineConfig, devices } from "@playwright/test";

/**
 * Родные контролы iPhone (К01, 20.11.2026): проверка в настоящем WebKit с размером iPhone 390.
 * Свой вход в самом тесте (код стенд подставляет сам), своя конфигурация — общий набор e2e
 * гоняет Chrome и Pixel 5, а здесь важен именно Safari-движок.
 *
 *   cd apps/web && E2E_BASE_URL=http://localhost:5461 E2E_API_URL=http://localhost:4961 \
 *     npx playwright test -c playwright.native-controls.config.ts
 *
 * Оговорка: WebKit для Windows у Playwright не умеет родные поля date/time/datetime-local (type
 * остаётся text), поэтому там проверяется запасной режим «обычное поле с подсказкой», а подпись
 * поверх родного поля на дате и времени проверяется в Chromium с телефонным UA (проект chromium-phone).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5461";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["native-controls.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL, serviceWorkers: "block", actionTimeout: 15_000, navigationTimeout: 45_000, screenshot: "only-on-failure" },
  projects: [
    {
      // Компьютер с английским Chrome: «Ноябрь 2026» по-русски и там (владелец и сотрудники на ПК).
      name: "chromium-desktop-en",
      grep: /Деньги/,
      use: { ...devices["Desktop Chrome"], locale: "en-US" },
    },
    { name: "webkit-iphone", use: { ...devices["iPhone 14"], viewport: { width: 390, height: 844 }, locale: "en-US" } },
    {
      // Chromium с телефонным UA и касанием: date/time поддержаны, подпись включается по UA.
      name: "chromium-phone",
      use: { ...devices["Desktop Chrome"], userAgent: devices["iPhone 14"].userAgent, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, locale: "en-US" },
    },
  ],
});
