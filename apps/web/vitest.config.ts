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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
