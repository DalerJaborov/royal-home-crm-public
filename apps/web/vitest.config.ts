import { defineConfig } from "vitest/config";

/**
 * Минимальный конфиг для юнит-тестов примитивов слоя 2 (`components/ui/__tests__`).
 * Отдельно от Playwright (`npm run e2e`) — это модульные тесты чистой логики
 * (таймеры стора), без браузера. `npm run build:web` их не запускает и не видит.
 */
export default defineConfig({
  test: {
    // "node", не "jsdom": тест бьёт по чистой логике стора/таймеров
    // (store/undoToast.ts), рендерить DOM не нужно, а jsdom не установлен —
    // добавлять тяжёлую зависимость ради одного теста нет смысла.
    environment: "node",
    // Source-scanning tests read the same tree. Unbounded concurrency made
    // eight tests hit their normal 5 s timeout on the previous shared runner.
    // Four workers passed all 1,658 tests without extending that timeout.
    maxWorkers: 4,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
