import { defineConfig, devices } from "@playwright/test";

/**
 * E2E-проверка CRM в настоящем браузере.
 *
 * Зачем она понадобилась: 26 июля в проде упала карточка объекта — хук вызывался
 * после раннего return. Ни `tsc`, ни 94 серверных теста этого не увидели: они
 * проверяют API, а не отрисовку. Экран был сломан, пока его не открыли руками.
 * Эти тесты открывают КАЖДЫЙ раздел и падают, если экран не отрисовался или в
 * консоли появилась ошибка.
 *
 * Где запускать:
 *   локально  — просто `npm run e2e --workspace=apps/web`: серверы поднимутся
 *               сами (см. webServer ниже), учётка берётся из сида;
 *   на проде  — E2E_BASE_URL=https://crm.royalhome.tj с E2E_PHONE
 *               в окружении (прод отдаёт код только в СМС, devCode там нет).
 */

/** Тесты идут против внешнего адреса — свои серверы поднимать не нужно и вредно. */
const usesExternalTarget = !!process.env.E2E_BASE_URL;
/**
 * E2E_PROD=1 — прогон против БОЕВОЙ сборки (`vite preview`) вместо dev-сервера.
 *
 * Нужен там, где dev физически не показывает правду: service worker в dev не
 * регистрируется, поэтому офлайн-режим на нём не проверяется вообще. Плюс dev
 * компилирует модули лениво — при параллельных воркерах первый заход в редкий
 * раздел иногда не укладывался в таймаут, и падал то один тест, то другой при
 * полностью исправном приложении. На собранном бандле такой лотереи нет.
 *
 * Сборка должна быть свежей: `npm run build:web` перед запуском.
 */
const usesProdBuild = process.env.E2E_PROD === "1";
const localPort = usesProdBuild ? 4173 : 5173;
/**
 * Адрес API для локального прогона — ОДИН переключатель на всё.
 *
 * Понадобился 13.08.2026: на рабочем ноутбуке Windows зарезервировала под Hyper-V
 * диапазоны 3918-4017 и 4018-4117, поэтому API падал на старте с
 * `EACCES 0.0.0.0:4000`, а прогон — с «Timed out waiting from config.webServer».
 * Со стороны это выглядит поломкой приложения, хотя ломается стенд.
 *
 * `E2E_API_URL` уже читали сами тесты (tests/e2e/pages/roleAuth.ts). Порт для
 * самого API (`PORT`) и адрес прокси Vite (`VITE_API_PROXY`) выводятся отсюда и
 * передаются серверам через `env` — иначе переключателей было бы три, и забытый
 * третий давал бы `ECONNREFUSED` в середине зелёного прогона (так и вышло с
 * первой попытки).
 *
 * Перенос на свободный порт целиком:
 *   E2E_API_URL=http://localhost:4300 npm run e2e --workspace=apps/web
 * Свободный порт искать так:
 *   netsh interface ipv4 show excludedportrange protocol=tcp
 */
const apiUrl = process.env.E2E_API_URL ?? "http://localhost:4000";
const apiPort = new URL(apiUrl).port || "4000";
export default defineConfig({
  // This suite changes a global rollout setting and owns a separate serial config.
  testIgnore: ["**/clean-shell.spec.ts", "**/audit-finance.spec.ts", "**/audit-client-focus.spec.ts", "**/audit-session-privacy.spec.ts"],
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${localPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Свой вход на каждый проект. Общая сессия не годится: access-токен живёт в
    // памяти, при загрузке страница идёт обновлять его по refresh-cookie, и два
    // проекта наперегонки обновляют один токен — проигравший улетает на /login.
    { name: "setup-chromium", testMatch: /.*\.setup\.ts/ },
    { name: "setup-mobile", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "playwright/.auth/chromium.json" },
      dependencies: ["setup-chromium"],
    },
    {
      // Мобильный проход: половина замечаний владельца была именно про телефон,
      // а на десктопе они не воспроизводятся.
      name: "mobile",
      use: { ...devices["Pixel 5"], storageState: "playwright/.auth/mobile.json" },
      dependencies: ["setup-mobile"],
    },
  ],

  /**
   * Серверы поднимаются самими тестами.
   *
   * Раньше их требовалось запускать руками, и это дважды дало ложное падение:
   * API перезапустили, старый Vite продолжал проксировать в никуда, вход
   * отдавал 500 — тесты падали на auth.setup при полностью исправном
   * приложении. Отладка уходила в приложение, хотя ломался стенд.
   *
   * reuseExistingServer: если серверы уже подняты для разработки, Playwright
   * берёт их и ничего не перезапускает — привычный рабочий цикл не меняется.
   */
  webServer: usesExternalTarget
    ? undefined
    : [
        {
          command: "npm run dev:api --prefix ../..",
          url: `${apiUrl}/api/v1/health`,
          // API_RATE_LIMIT: двенадцать «браузеров» прогона ходят под одной учёткой,
          // то есть под одним ключом лимитера, и упирались в честный потолок 600
          // запросов за пять минут — списки застревали на «Слишком много запросов»,
          // и падало 14 тестов при исправном приложении. Переменную сервер слушает
          // только вне прода (см. app.ts), боевой потолок ею не сдвинуть.
          env: { PORT: apiPort, API_RATE_LIMIT: "1000000", LOGIN_CODE_DEV_ECHO: "1" },
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: "ignore",
          stderr: "pipe",
        },
        {
          command: usesProdBuild ? "npm run preview --prefix ." : "npm run dev --prefix .",
          url: `http://localhost:${localPort}`,
          env: { VITE_API_PROXY: apiUrl },
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: "ignore",
          stderr: "pipe",
        },
      ],
});
